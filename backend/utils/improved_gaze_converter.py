#!/usr/bin/env python3
"""
gaze_converter.py

This script processes raw gaze data captured by an open-source system (e.g. WebGazer)
and converts it into a fixation-grouped format similar to commercial outputs.
It uses DBSCAN clustering on spatial features (and optionally on time) to group
individual gaze points into fixations. In addition, even points that might have
a fixation validity of 0 are grouped with their neighbors so that the sequential
structure is preserved. (Only values with a fixation validity of 1 are used for some analyses.)

Usage:
    python gaze_converter.py input_file.csv output_file.csv

Parameters:
    input_file  : Path to the raw gaze data CSV file.
    output_file : Path to save the processed CSV with fixation IDs.

Updated:
- FPOGX = x / SCREEN_W, FPOGY = y / SCREEN_H (monitor-based, not min/max)
- Spatio-temporal DBSCAN + time-gap splitting; bridge zero-ID runs; renumber to 1..N
- FPOGS = seeded start (one median-Delta-t earlier per fixation, clamped >= 0)
- FPOGD = row-wise (TIME_NUM - FPOGS) in seconds; first sample forced = 0
- AOI assignment
- Reads from best_params_values_mod to find fixations
- bridges noise using time and space, not just space
"""

import sys, os
import glob
import pandas as pd
import numpy as np
import json
from pathlib import Path
from st_dbscan import ST_DBSCAN

# Use best eps values found
BASE_DIR = Path(__file__).parent

PARAMS_CSV = BASE_DIR / "best_params" / "best_param_values_mod.csv"
_params_df = pd.read_csv(PARAMS_CSV, sep=None, engine="python")
PARAMS = _params_df.set_index("ID")[["Best_EPS_Spatial", "Best_EPS_Temporal", "Best_MIN_SAMPLES"]].to_dict("index")

# SCREEN_W, SCREEN_H = 1920.0, 1080.0
SCREEN_W, SCREEN_H = float(sys.argv[1]), float(sys.argv[2])

# Function to normalize a value given a min and max.
def normalize(value, min_value, max_value):
    return (value - min_value) / (max_value - min_value)

# Function to check if a point (normalized) falls within an AOI (unchanged).
def is_point_in_aoi(x, y, aoi):
    x_min = aoi['x']
    x_max = aoi['x'] + aoi['width']
    y_min = aoi['y']
    y_max = aoi['y'] + aoi['height']
    return x_min <= x <= x_max and y_min <= y <= y_max

# Function to calculate saccade magnitude. (unchanged)
def calculate_saccade_magnitude(x1, y1, x2, y2):
    return np.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

# Function to calculate saccade direction. (unchanged)
def calculate_saccade_direction(x1, y1, x2, y2):
    return np.degrees(np.arctan2(y2 - y1, x2 - x1))

# (Optional) Function to calculate AOI metrics (unchanged).
def calculate_aoi_metrics(data, aoi_config):
    results = []
    total_fixations = data[data['FPOGV'] == 1].shape[0]
    total_duration = data[data['FPOGV'] == 1]['FPOGD'].sum()
    for index, aoi in enumerate(aoi_config):
        aoi_name = f"AOI_{index + 1}"
        fixations_in_aoi = data[(data[aoi_name] == 1) & (data['FPOGV'] == 1)]
        fixation_proportion = len(fixations_in_aoi) / total_fixations if total_fixations > 0 else 0
        duration_proportion = fixations_in_aoi['FPOGD'].sum() / total_duration if total_duration > 0 else 0
        results.append({
            'AOI': aoi_name,
            'Proportion_of_Fixations': fixation_proportion,
            'Proportion_of_Duration': duration_proportion
        })
    return results

# (Optional) Function to calculate AOI transitions. (unchanged)
def calculate_aoi_transitions(data):
    transitions = []
    for i in range(len(data) - 1):
        current_aoi = data.iloc[i]['AOI']
        next_aoi = data.iloc[i + 1]['AOI']
        if current_aoi != next_aoi:
            transitions.append((current_aoi, next_aoi))
    return transitions

# Function to add saccade features. (unchanged)
def add_saccade_features(data):
    data['SACCADE_MAG'] = data.apply(
        lambda row: calculate_saccade_magnitude(
            data['FPOGX'].shift(1).loc[row.name],
            data['FPOGY'].shift(1).loc[row.name],
            row['FPOGX'],
            row['FPOGY']
        ) if row.name > 0 else 0.0,
        axis=1
    )
    data['SACCADE_DIR'] = data.apply(
        lambda row: calculate_saccade_direction(
            data['FPOGX'].shift(1).loc[row.name],
            data['FPOGY'].shift(1).loc[row.name],
            row['FPOGX'],
            row['FPOGY']
        ) if row.name > 0 else 0.0,
        axis=1
    )
    return data

# Function to add placeholder fields. (unchanged)
def add_placeholder_fields(data):
    placeholders = {
        'MEDIA_ID': '', 'MEDIA_NAME': '', 'CNT': np.arange(0, len(data)), 'BPOGX': 0.0, 'BPOGY': 0.0, 'BPOGV': 0,
        'CX': 0, 'CY': 0, 'CS': '', 'KB': 0, 'KBS': 0, 'USER': '',
        'LPCX': 0.0, 'LPCY': 0.0, 'LPD': 0, 'LPS': 0, 'LPV': 0,
        'RPCX': 0.0, 'RPCY': 0.0, 'RPD': 0, 'RPS': 0, 'RPV': 0,
        'BKID': 0, 'BKDUR': 0, 'BKPMIN': 0, 'LPMM': 4, 'LPMMV': 1,
        'RPMM': 4, 'RPMMV': 1, 'DIAL': 0, 'DIALV': 0,
        'GSR': 0, 'GSRV': 0, 'HR': 0, 'HRV': 0, 'HRP': 0, 'IBI': 0,
        'TTL0': 0, 'TTL1': 0, 'TTL2': 0, 'TTL3': 0, 'TTL4': 0,
        'TTL5': 0, 'TTL6': 0, 'TTLV': 0, 'PIXS': 0, 'PIXV': 0, 'VID_FRAME': 0
    }
    for column, default in placeholders.items():
        if column not in data.columns:
            data[column] = default
    return data

def bridge_and_monotonicize(data, epsSpat, epsT, require_within=None):
    # Bridge -1's
    mask_fix = data["FPOGID"] != -1
    if mask_fix.any():
        grp = data[mask_fix].groupby("FPOGID")
        fix_ids = grp.size().index.to_numpy()
        cx = grp["FPOGX"].mean().to_numpy()
        cy = grp["FPOGY"].mean().to_numpy()
        ts = grp["TIME_NUM"].min().to_numpy()
        te = grp["TIME_NUM"].max().to_numpy()

        noise_idx = data.index[data["FPOGID"] == -1].to_numpy()
        # handle degenerate eps just in case
        eS = epsSpat if epsSpat > 0 else 1e-9
        eT = epsT    if epsT    > 0 else 1e-9


        for i in noise_idx:
            t = float(data.at[i, "TIME_NUM"])
            x = float(data.at[i, "FPOGX"])
            y = float(data.at[i, "FPOGY"])

            # For rows with FPOGID == -1, assign to the nearest fixation using a normalized ST distance:
            # D = sqrt( (ds/epsSpat)^2 + (dt/epsT)^2 )
            # where ds = distance to fixation centroid in normalized screen coords (FPOGX,FPOGY),
            #       dt = time distance to fixation [start,end] span (0 if inside span).

            # time distance to span
            inside = (t >= ts) & (t <= te)
            dt = np.where(inside, 0.0, np.minimum(np.abs(t - ts), np.abs(t - te)))
            # spatial distance to centroid
            ds = np.hypot(x - cx, y - cy)
            # normalized joint distance
            D = np.sqrt((ds / eS) ** 2 + (dt / eT) ** 2)

            j = int(np.argmin(D))
            if (require_within is None) or (D[j] <= require_within):
                data.at[i, "FPOGID"] = int(fix_ids[j])

    # Relabels and makes sure no ID revisiting happens
    labs = data["FPOGID"].to_numpy()
    new_ids = np.full(labs.shape, -1, dtype=int)
    curr_id = 0
    prev_lab = None
    for idx, lab in enumerate(labs):
        if lab == -1:
            prev_lab = None  # noise breaks the run
            continue
        if prev_lab != lab:
            curr_id += 1     # new contiguous segment
        new_ids[idx] = curr_id
        prev_lab = lab

    data["FPOGID"] = new_ids
    return data

# Process gaze data with AOI detection and DBSCAN-based fixation analysis.
def process_gaze_data(gaze_file, aoi_config_file='aoi_config.json',
                      output_file='processed_gaze_data.csv', fixation_file='fixations.csv',
                      epsSpat=0.03, epsT=0.8, min_samples=5):
    #added screen width and height

    # --- STEP 1: Read header to extract base time ---
    raw_columns = pd.read_csv(gaze_file, nrows=0).columns
    time_header_candidates = [col for col in raw_columns if col.startswith("TIME")]
    if not time_header_candidates:
        raise ValueError("Could not find a TIME column in the expected format.")
    raw_time_header = time_header_candidates[0]
    base_time_str = raw_time_header[raw_time_header.find("(")+1 : raw_time_header.find(")")]

    # --- STEP 2: Load the raw gaze data ---
    data = pd.read_csv(gaze_file)
    data = data.rename(columns={raw_time_header: "TIME_REL"})

    # Build numeric time (seconds) with TIMETICK priority; start at 0; stable sort
    if 'TIMETICK' in data.columns:
        data['TIME_NUM'] = data['TIMETICK'].astype(float) / 1e7
    else:
        data['TIME_NUM'] = data['TIME_REL'].astype(float)
    data['TIME_NUM'] -= data['TIME_NUM'].iloc[0]
    data = data.sort_values(by='TIME_NUM', kind='mergesort').reset_index(drop=True)

    # --- STEP 3: Normalize X and Y coordinates to monitor (FIXED) ---
    if 'x' not in data.columns or 'y' not in data.columns:
        raise ValueError("Input must contain 'x' and 'y' columns.")
    data['FPOGX'] = data['x'] / SCREEN_W
    data['FPOGY'] = data['y'] / SCREEN_H

    # --- STEP 4: Fixation detection via spatio-temporal DBSCAN (FIXED) ---
    Time = data['TIME_NUM'].astype(float).to_numpy()
    x = data['FPOGX'].astype(float).to_numpy()
    y = data['FPOGY'].astype(float).to_numpy()
    spatial_norm = data[['FPOGX', 'FPOGY']].astype(float).to_numpy()
    X_feat = np.column_stack([Time, x, y])

    # the order that must enter the fit function must be ['t', 'x', 'y']
    st_db = ST_DBSCAN(eps1=epsSpat, eps2=epsT, min_samples=min_samples).fit(X_feat)
    data['st_db_label'] = st_db.labels
    labels = data['st_db_label'].to_numpy()

    # Assign gaze points to their label under FPOGID
    data['FPOGID'] = labels.astype(int)

    # bridge noise
    data = bridge_and_monotonicize(data, epsSpat=epsSpat, epsT=epsT, require_within=None)

    # --- STEP 5c: No Seeded FPOGS and row-wise FPOGD (FIXED) ---
    fix_group = data.groupby('FPOGID')['TIME_NUM']
    true_start = fix_group.min()  # first sample time per fixation

    # Write per-row FPOGS and recompute FPOGD
    data['FPOGS'] = data['FPOGID'].map(true_start).astype(float)
    data['FPOGD'] = (data['TIME_NUM'] - data['FPOGS']).clip(lower=0.0)
    # keep very first row exactly 0 for neatness
    if len(data) > 0:
        data.loc[data.index[0], 'FPOGD'] = 0.0

    # If the gaze point is -1 (noise) then FPOGV == 0, else 1
    data.loc[data['st_db_label'] == -1, 'FPOGV'] = 0
    data.loc[data['st_db_label'] != -1, 'FPOGV'] = 1

    # If the fixation is at least 100ms, then valid for all points EXCEPT noise.
    fix_durations = data.groupby('FPOGID')['FPOGD'].max()  # duration per fixation
    valid_map = (fix_durations >= 0.1).astype(int)  # 1 if >=100ms else 0

    data.loc[data['st_db_label'] != -1, 'FPOGV'] = (
        data.loc[data['st_db_label'] != -1, 'FPOGID'].map(valid_map).fillna(0).astype(int)
    )
    data['FPOGV'] = data['FPOGV'].astype(int)


    # --- STEP 6: AOI assignment ---
    AOI_Q, AOI_V = None, None
    if os.path.exists(aoi_config_file):
        try:
            with open(aoi_config_file, 'r') as f:
                aoi_config = json.load(f)
            if isinstance(aoi_config, list):
                if len(aoi_config) >= 1:
                    AOI_Q = aoi_config[0]
                if len(aoi_config) >= 2:
                    AOI_V = aoi_config[1]
        except json.JSONDecodeError:
            print(f"Error: AOI configuration file '{aoi_config_file}' is not valid JSON.")
            aoi_config = []
    else:
        print(f"Warning: AOI configuration file '{aoi_config_file}' not found. Proceeding without AOIs.")
        aoi_config = []

    def assign_aoi(row):
        # Convert normalized to pixel before checking (FIXED)
        x_px = row['FPOGX'] * SCREEN_W
        y_px = row['FPOGY'] * SCREEN_H

        # Any (0,0) coordinate is None
        if x_px == 0 and y_px == 0:
            return "None"

        if AOI_Q and is_point_in_aoi(x_px, y_px, AOI_Q):
            return "AOI_Q"
        if AOI_V and is_point_in_aoi(x_px, y_px, AOI_V):
            return "AOI_V"
        return "None"

    data['AOI'] = data.apply(assign_aoi, axis=1)

    # --- STEP 7: (Code 1 had "Compute fixation metrics") —
    # We already computed FPOGS/FPOGD above

    # --- STEP 8: Add placeholder fields ---
    data = add_placeholder_fields(data)

    # --- STEP 9: Add saccade features (same helpers as Code 1) ---
    data = add_saccade_features(data)

    # --- STEP 10: Prepare final output (same ordering as Code 1) ---
    new_time_header = f"TIME({base_time_str})"
    data = data.rename(columns={"TIME_REL": new_time_header})

    # Drop intermediate columns.
    data = data.drop(columns=["db_label"], errors='ignore')
    columns_order = [
        'MEDIA_ID', 'MEDIA_NAME', 'CNT', new_time_header, 'TIMETICK',
        'FPOGX', 'FPOGY', 'FPOGS', 'FPOGD', 'FPOGID', 'FPOGV',
        'BPOGX', 'BPOGY', 'BPOGV', 'CX', 'CY', 'CS',
        'KB', 'KBS', 'USER', 'LPCX', 'LPCY', 'LPD', 'LPS', 'LPV',
        'RPCX', 'RPCY', 'RPD', 'RPS', 'RPV', 'BKID', 'BKDUR', 'BKPMIN',
        'LPMM', 'LPMMV', 'RPMM', 'RPMMV', 'DIAL', 'DIALV',
        'GSR', 'GSRV', 'HR', 'HRV', 'HRP', 'IBI',
        'TTL0', 'TTL1', 'TTL2', 'TTL3', 'TTL4', 'TTL5', 'TTL6', 'TTLV',
        'PIXS', 'PIXV', 'AOI', 'SACCADE_MAG', 'SACCADE_DIR', 'VID_FRAME'
    ]
    for c in columns_order:
        if c not in data.columns:
            data[c] = 0 if c not in ('MEDIA_ID', 'MEDIA_NAME', 'CS', 'USER', 'AOI') else ''
    data = data[columns_order]
    data.to_csv(BASE_DIR / "fixations" / output_file, index=False)



if __name__ == "__main__":
    data_dir = BASE_DIR / "raw_WG_data"
    raw_files = list(data_dir.glob("session_*.csv"))

    if not raw_files:
        print("No raw gaze data files matching 'session_*_.csv' were found.")
    else:
        aoi_config_file = str(BASE_DIR / 'aoi_config.json')

        output_dir = BASE_DIR / "fixations"
        os.makedirs(output_dir, exist_ok=True) # create output folder if missing

        for gaze_file in raw_files:
            base_name = os.path.basename(gaze_file)
            participant_id = int(base_name.split("_")[1])

            # pull per-participant params
            p = PARAMS.get(participant_id, {"Best_EPS_Spatial": 0, "Best_EPS_Temporal": 0, "Best_MIN_SAMPLES": 0})
            epsSpat, epsT, min_samples = float(p["Best_EPS_Spatial"]), float(p["Best_EPS_Temporal"]), int(p["Best_MIN_SAMPLES"])

            output_file = f"{participant_id}_all_gaze.csv"
            fixation_file = f"{participant_id}_fixations.csv"

            process_gaze_data(
                gaze_file,
                aoi_config_file=aoi_config_file,
                output_file=output_file,
                fixation_file=fixation_file,
                epsSpat=epsSpat,
                epsT=epsT,
                min_samples=min_samples
            )

            print(f"{participant_id}_all_gaze.csv outputted into fixations")

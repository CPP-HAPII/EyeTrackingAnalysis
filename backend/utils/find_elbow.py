# k_distance_stdbscan_from_csv.py
# Load your CSV, detect X/Y/Time columns, and plot k-distance curves
# to estimate eps1 (spatial) and eps2 (temporal) for ST-DBSCAN.

import sys
import pandas as pd
import numpy as np
from sklearn.neighbors import NearestNeighbors
from pathlib import Path
from kneed import KneeLocator
from natsort import natsorted

# --- Config ---
BASE_DIR = Path(__file__).parent

FOLDER_PATH = BASE_DIR / "./raw_WG_data"

# many different ways to decide on min_sample
# 1) ln(x) where x is the size of the data set
# 2) 2 * the features in your dataset (which is being used here)
# 3) standard 4-5 found in papers
# in the end it depends on your dataset
MIN_SAMPLES = 6

# SCREEN_W, SCREEN_H = 1920.0, 1080.0
SCREEN_W, SCREEN_H = float(sys.argv[1]), float(sys.argv[2])
OPTION = sys.argv[3] # "single" or "all"

def get_columns(df):
    cols_lower = {c.lower(): c for c in df.columns}

    # Spatial columns (X, Y)
    x_col = cols_lower.get("x")
    y_col = cols_lower.get("y")

    # Time column
    time_candidates = [c for c in df.columns if c.lower().startswith("time")]
    time_col = time_candidates[0]

    return x_col, y_col, time_col

# k-distance calculation and sort here
def k_distance_sorted(arr, k):
    nn = NearestNeighbors(n_neighbors=k).fit(arr)
    dists, _ = nn.kneighbors(arr)
    kth = dists[:, -1]
    return np.sort(kth)

def output_summary(path, current, cols, length, min_sample, epsS, epsT):
    with open(path, "a") as file:
        file.write(f"Participant: {current}\n")
        file.write(f"Detected columns -> X: '{cols[0]}', Y: '{cols[1]}', Time: '{cols[2]}'\n")
        file.write(f"Rows used: {length}\n")
        file.write(f"min_samples: {min_sample}\n")
        file.write(f"Suggested eps1 (spatial, pixels): {epsS:.6f}\n")
        file.write(f"Suggested eps2 (temporal, seconds): {epsT:.6f}\n")
        file.write("-------------------------------------------------------------------------\n")

def output_summary_csv(df, p, epsS, epsT, min_sample):
    df.loc[len(df)] = [p, epsS, epsT, min_sample]

def process(filePath):
    # 1) Load CSV
    df = pd.read_csv(filePath)

    # 2) Detect columns
    x_col, y_col, time_col = get_columns(df)

    # 3) normalize spatial
    df[x_col] = df[x_col] / SCREEN_W
    df[y_col] = df[y_col] / SCREEN_H
    spatial_norm = df[[x_col, y_col]].to_numpy()

    temporal = df[[time_col]].to_numpy()

    # 4) Compute k-distance (k = MIN_SAMPLES)
    spatial_k = k_distance_sorted(spatial_norm, MIN_SAMPLES)
    temporal_k = k_distance_sorted(temporal, MIN_SAMPLES)

    # 5) Knee guesses
    spatial_x = np.arange(len(spatial_k))
    spatial_knee = KneeLocator(spatial_x, spatial_k, curve='convex', direction='increasing')
    eps1_guess = spatial_knee.knee_y  # pixels

    temporal_x = np.arange(len(temporal_k))
    temporal_knee = KneeLocator(temporal_x, temporal_k, curve='convex', direction='increasing')
    eps2_guess = temporal_knee.knee_y # seconds

    return x_col, y_col, time_col, len(df), eps1_guess, eps2_guess, spatial_knee, temporal_knee

def run_all():
    df = pd.DataFrame(columns=['ID', 'EPS_Spatial', 'EPS_Temporal', 'MIN_SAMPLES'])

    folderPath = FOLDER_PATH
    files = [f for f in folderPath.iterdir() if f.is_file() and f.suffix == ".csv"]

    for file in natsorted(files):
        x_col, y_col, time_col, length, epsS, epsT, _, _ = process(file)

        current = file.stem.split("_")[1]

        output_summary_csv(df, current, epsS, epsT, MIN_SAMPLES)
    df.to_csv(BASE_DIR / "elbow_knee_values" / "eps_values.csv", mode='w', index=False)


def main():
    run_all()

if __name__ == "__main__":
    main()

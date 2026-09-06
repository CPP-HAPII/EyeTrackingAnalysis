import sys
import pandas as pd
from st_dbscan import ST_DBSCAN
from pathlib import Path
from itertools import product
from sklearn.metrics import pairwise_distances
import numpy as np
from natsort import natsorted

# --- Config ---
BASE_DIR = Path(__file__).parent

# input folder
FOLDER_PATH = BASE_DIR / "./raw_WG_data"

#CSV path with all of the starting point eps values
EPS_CSV_PATH = BASE_DIR / "elbow_knee_values" / "eps_values.csv"

# SCREEN_W, SCREEN_H = 1920.0, 1080.0
SCREEN_W, SCREEN_H = float(sys.argv[1]), float(sys.argv[2])

def output_summary(path, current, epsS, epsT, min_sample, score, cluster_count, noise_count, length):
    with open(path, "a") as file:
        file.write(f"Participant: {current}\n")
        file.write(f"Best min_samples: {min_sample}\n")
        file.write(f"Best eps1 (spatial, pixels): {epsS:.6f}\n")
        file.write(f"Best eps2 (temporal, seconds): {epsT:.6f}\n")
        file.write(f"Score: {score:.6f}\n")
        file.write(f"Cluster Count: {cluster_count}\n")
        file.write(f"Rows: {length}\n")
        file.write(f"Noise Count: {noise_count}\n")
        file.write("-------------------------------------------------------------------------\n")

def output_summary_csv(df, p, epsS, epsT, min_sample, score, cluster_count, noise_count, length):
    df.loc[len(df)] = [p, epsS, epsT, min_sample, score, cluster_count, length, noise_count]

def get_columns(df):
    cols_lower = {c.lower(): c for c in df.columns}

    # Spatial columns (X, Y)
    x_col = cols_lower.get("x")
    y_col = cols_lower.get("y")

    # Time column
    time_candidates = [c for c in df.columns if c.lower().startswith("time")]
    time_col = time_candidates[0]

    return x_col, y_col, time_col

def compactness_score(X_space, X_time, labels):
    unique_labels = set(labels)
    unique_labels.discard(-1)

    spatial_scores = []
    temporal_scores = []

    for label in unique_labels:
        mask = labels == label
        if np.sum(mask) <= 1:
            continue

        spatial = X_space[mask]
        temporal = X_time[mask].reshape(-1,1)

        spatial_d = pairwise_distances(spatial)
        temporal_d = pairwise_distances(temporal)

        spatial_scores.append(np.mean(spatial_d))
        temporal_scores.append(np.mean(temporal_d))

    spatial_mean = np.mean(spatial_scores) if spatial_scores else np.inf
    temporal_mean = np.mean(temporal_scores) if temporal_scores else np.inf

    # spatio-temporal density ratio normalized to be our score
    # range [0-1] higher the better its more compact
    # D = avg spatial distance + avg temporal distance
    # 1 + D in the denominator will normalize the range to be between [0-1]
    # smaller the denominator tighter the cluster and higher score
    d = spatial_mean + temporal_mean
    compactness = 1.0 / (1 + d)

    return compactness

def fitness_score(X_space, X_time, labels):
    n_points = len(labels)
    n_noise = np.sum(labels == -1)
    n_clusters = len(set(labels)) - (1 if -1 in labels else 0)

    compactness = compactness_score(X_space, X_time, labels)

    # penalize noise and too few clusters
    # noise ratio = n_noise / n_points
    # cluster count penalty = 1 / n_clusters + 1
    # add these and it will create the penalty value
    penalty = (n_noise / n_points) + (1.0 / (n_clusters + 1))

    return compactness - penalty

def process(filePath, epsS_options, epsT_options, min_samples):
    # 1) Load CSV
    df = pd.read_csv(filePath)

    # 2) Detect columns
    x_col, y_col, time_col = get_columns(df)

    # 3) normalize spatial
    df[x_col] = df[x_col] / SCREEN_W
    df[y_col] = df[y_col] / SCREEN_H
    spatial_norm = df[[x_col, y_col]].astype(float).to_numpy()
    temporal = df[[time_col]].astype(float).to_numpy()

    # prepare for tuning
    X_feat = np.column_stack([temporal, spatial_norm])

    best_score = -1
    best_params = None
    cluster_count = -1
    noise_count = -1

    # (Grid Search) try every combination from the eps options and min samples
    for epsS, epsT, min_sample in product(epsS_options, epsT_options, min_samples):
        # set up clustering model and get the labels after cluster
        st_db = ST_DBSCAN(eps1=epsS, eps2=epsT, min_samples=min_sample).fit(X_feat)
        labels = st_db.labels

        # count the amount of clusters; subtract by 1 if the -1 cluster exist
        # because it does not count as a cluster. those points are noise if -1
        n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
        n_noise = np.sum(labels == -1)

        # if all noise or just one cluster just skip
        if n_clusters <= 1:
            continue

        # tried to use sihouette score, but found out it didnt make sense
        # create fitness_score that checkc for compactness
        # spatio-temporal density ratio (cluster compactness/separation)
        score = fitness_score(spatial_norm, temporal, labels)

        if score > best_score:
            best_score = score
            best_params = (epsS, epsT, min_sample)
            cluster_count = n_clusters
            noise_count = n_noise

    # Fall back to the initial eps guesses if the grid search never found
    # a configuration with more than one cluster (e.g. very short sessions).
    if best_params is None:
        best_params = (epsS_options[0], epsT_options[0], min_samples[0])
        cluster_count = 0
        noise_count = len(df)

    return best_params, best_score, cluster_count, noise_count, len(df)

def main():
    folderPath = FOLDER_PATH
    files = [f for f in folderPath.iterdir() if f.is_file() and f.suffix == ".csv"]

    results = pd.DataFrame(columns=['ID', 'Best_EPS_Spatial', 'Best_EPS_Temporal', 'Best_MIN_SAMPLES', 'Score', 'Cluster_Count', 'Rows', 'Noise_Count'])

    for file in natsorted(files):
        df = pd.read_csv(EPS_CSV_PATH)
        p = int(file.stem.split("_")[1])

        # retrieve the eps starting point values from a csv
        row = df.loc[df['ID'] == p]
        initial_epsS = row['EPS_Spatial'].values[0]
        initial_epsT = row['EPS_Temporal'].values[0]

        # create the grid space to get ready for the grid search
        epsS_grid = np.linspace(1*initial_epsS, 3*initial_epsS, 10)
        epsT_grid = np.linspace(0.01*initial_epsT, 1.5*initial_epsT, 10)
        min_sample_grid = [3]

        best_params, score, cluster_count, noise_count, length = process(file, epsS_grid, epsT_grid, min_sample_grid)

        output_summary_csv(results, p, best_params[0], best_params[1], best_params[2], score, cluster_count, noise_count, length)

    results.to_csv(BASE_DIR / "best_params" / "best_param_values_mod.csv", mode='w', index=False)

if __name__ == "__main__":
    main()

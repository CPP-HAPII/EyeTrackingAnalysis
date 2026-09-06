"""Vendored spatio-temporal DBSCAN.

Drop-in replacement for the `st_dbscan` PyPI package (Eren Cakmak's
implementation), which ships broken metadata that modern pip/uv reject. The
algorithm is unchanged: build a precomputed spatial distance matrix, mask out
pairs that are farther apart in time than `eps2`, then run DBSCAN with `eps1`
as the spatial radius.

Interface matches the original usage in the pipeline:
    ST_DBSCAN(eps1=..., eps2=..., min_samples=...).fit(X).labels
where X has time in column 0 and spatial coordinates in columns 1..N.
"""
import numpy as np
from scipy.spatial.distance import pdist, squareform
from sklearn.cluster import DBSCAN


class ST_DBSCAN:
    """Spatio-temporal DBSCAN clustering.

    Parameters
    ----------
    eps1 : float
        Spatial neighborhood radius.
    eps2 : float
        Temporal neighborhood radius (max time difference to be neighbors).
    min_samples : int
        Minimum number of samples in a neighborhood to form a core point.
    metric : str
        Distance metric passed to ``scipy.spatial.distance.pdist``.
    """

    def __init__(self, eps1=0.5, eps2=10, min_samples=5, metric="euclidean"):
        self.eps1 = eps1
        self.eps2 = eps2
        self.min_samples = min_samples
        self.metric = metric
        self.labels = None

    def fit(self, X):
        """Cluster the (n_samples, 1 + n_spatial) array X; sets self.labels."""
        X = np.asarray(X, dtype=float)
        n = X.shape[0]

        # Pairwise temporal and spatial distances (condensed form).
        time_dist = pdist(X[:, 0].reshape(n, 1), metric=self.metric)
        euc_dist = pdist(X[:, 1:], metric=self.metric)

        # Pairs beyond the temporal radius are pushed out of spatial reach.
        dist = np.where(time_dist <= self.eps2, euc_dist, 2 * self.eps1)

        db = DBSCAN(
            eps=self.eps1,
            min_samples=self.min_samples,
            metric="precomputed",
        ).fit(squareform(dist))

        self.labels = db.labels_
        return self

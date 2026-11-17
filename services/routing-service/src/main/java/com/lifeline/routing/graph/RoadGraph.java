package com.lifeline.routing.graph;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Immutable directed road graph in compressed sparse row (CSR) form: all
 * edges live in flat primitive arrays, so A* touches contiguous memory and
 * allocates nothing per edge. A uniform grid bucket index makes snapping a
 * coordinate to its nearest node O(1) on average.
 */
public final class RoadGraph {
    private final int[] ids;
    private final double[] lat;
    private final double[] lng;
    private final int[] offsets;
    private final int[] targets;
    private final double[] lengthM;
    private final double[] travelS;
    private final double maxSpeedMps;

    private final double minLat;
    private final double minLng;
    private final double cell;
    private final int cols;
    private final int rows;
    private final int[][] buckets;

    private RoadGraph(int[] ids, double[] lat, double[] lng, int[] offsets, int[] targets,
                      double[] lengthM, double[] travelS, double maxSpeedMps) {
        this.ids = ids;
        this.lat = lat;
        this.lng = lng;
        this.offsets = offsets;
        this.targets = targets;
        this.lengthM = lengthM;
        this.travelS = travelS;
        this.maxSpeedMps = maxSpeedMps;

        double mnLat = Double.MAX_VALUE, mxLat = -Double.MAX_VALUE, mnLng = Double.MAX_VALUE, mxLng = -Double.MAX_VALUE;
        for (int i = 0; i < lat.length; i++) {
            mnLat = Math.min(mnLat, lat[i]);
            mxLat = Math.max(mxLat, lat[i]);
            mnLng = Math.min(mnLng, lng[i]);
            mxLng = Math.max(mxLng, lng[i]);
        }
        if (lat.length == 0) {
            mnLat = mxLat = mnLng = mxLng = 0;
        }
        this.minLat = mnLat;
        this.minLng = mnLng;
        // ~2 nodes per bucket on average.
        double span = Math.max(mxLat - mnLat, mxLng - mnLng);
        int side = Math.max(1, (int) Math.ceil(Math.sqrt(Math.max(1, lat.length) / 2.0)));
        this.cell = span > 0 ? span / side : 1;
        this.cols = (int) Math.floor((mxLng - mnLng) / cell) + 1;
        this.rows = (int) Math.floor((mxLat - mnLat) / cell) + 1;
        List<List<Integer>> tmp = new ArrayList<>(rows * cols);
        for (int i = 0; i < rows * cols; i++) tmp.add(new ArrayList<>());
        for (int i = 0; i < lat.length; i++) tmp.get(bucketOf(lat[i], lng[i])).add(i);
        this.buckets = new int[rows * cols][];
        for (int i = 0; i < tmp.size(); i++) buckets[i] = tmp.get(i).stream().mapToInt(Integer::intValue).toArray();
    }

    public int size() {
        return lat.length;
    }

    public int edgeCount() {
        return targets.length;
    }

    public int externalId(int idx) {
        return ids[idx];
    }

    public double lat(int idx) {
        return lat[idx];
    }

    public double lng(int idx) {
        return lng[idx];
    }

    public int edgeStart(int idx) {
        return offsets[idx];
    }

    public int edgeEnd(int idx) {
        return offsets[idx + 1];
    }

    public int target(int edge) {
        return targets[edge];
    }

    public double length(int edge) {
        return lengthM[edge];
    }

    public double travelSeconds(int edge) {
        return travelS[edge];
    }

    public double maxSpeedMps() {
        return maxSpeedMps;
    }

    private int bucketOf(double la, double ln) {
        int r = Math.min(rows - 1, Math.max(0, (int) Math.floor((la - minLat) / cell)));
        int c = Math.min(cols - 1, Math.max(0, (int) Math.floor((ln - minLng) / cell)));
        return r * cols + c;
    }

    /** Index of the node closest to the coordinate, or -1 for an empty graph. */
    public int nearestNode(double la, double ln) {
        if (lat.length == 0) return -1;
        int center = bucketOf(la, ln);
        int cr = center / cols;
        int cc = center % cols;
        int best = -1;
        double bestD = Double.MAX_VALUE;
        // Expand rings of buckets until a hit is found, then one more ring to
        // be sure a closer node isn't sitting just across a bucket boundary.
        int maxRing = Math.max(rows, cols);
        int foundAt = -1;
        for (int ring = 0; ring <= maxRing; ring++) {
            for (int r = cr - ring; r <= cr + ring; r++) {
                for (int c = cc - ring; c <= cc + ring; c++) {
                    if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
                    if (Math.max(Math.abs(r - cr), Math.abs(c - cc)) != ring) continue;
                    for (int n : buckets[r * cols + c]) {
                        double d = Geo.haversine(la, ln, lat[n], lng[n]);
                        if (d < bestD) {
                            bestD = d;
                            best = n;
                        }
                    }
                }
            }
            if (best >= 0 && foundAt < 0) foundAt = ring;
            if (foundAt >= 0 && ring >= foundAt + 1) break;
        }
        return best;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private final Map<Integer, Integer> index = new HashMap<>();
        private final List<double[]> nodes = new ArrayList<>();
        private final List<Integer> nodeIds = new ArrayList<>();
        private final List<double[]> edges = new ArrayList<>();

        public Builder node(int id, double la, double ln) {
            index.put(id, nodes.size());
            nodeIds.add(id);
            nodes.add(new double[]{la, ln});
            return this;
        }

        /** Directed edge; length in metres, speed in km/h. */
        public Builder edge(int fromId, int toId, double lengthM, double speedKph) {
            edges.add(new double[]{fromId, toId, lengthM, speedKph});
            return this;
        }

        public RoadGraph build() {
            int n = nodes.size();
            int[] ids = nodeIds.stream().mapToInt(Integer::intValue).toArray();
            double[] la = new double[n];
            double[] ln = new double[n];
            for (int i = 0; i < n; i++) {
                la[i] = nodes.get(i)[0];
                ln[i] = nodes.get(i)[1];
            }
            int[] counts = new int[n + 1];
            List<double[]> valid = new ArrayList<>(edges.size());
            for (double[] e : edges) {
                Integer f = index.get((int) e[0]);
                Integer t = index.get((int) e[1]);
                if (f == null || t == null || e[3] <= 0) continue;
                valid.add(new double[]{f, t, e[2], e[3]});
                counts[f + 1]++;
            }
            for (int i = 0; i < n; i++) counts[i + 1] += counts[i];
            int[] offsets = Arrays.copyOf(counts, n + 1);
            int[] cursor = Arrays.copyOf(counts, n);
            int m = valid.size();
            int[] targets = new int[m];
            double[] len = new double[m];
            double[] time = new double[m];
            double maxSpeed = 0;
            for (double[] e : valid) {
                int pos = cursor[(int) e[0]]++;
                targets[pos] = (int) e[1];
                len[pos] = e[2];
                double mps = Geo.kphToMps(e[3]);
                time[pos] = e[2] / mps;
                maxSpeed = Math.max(maxSpeed, mps);
            }
            return new RoadGraph(ids, la, ln, offsets, targets, len, time, maxSpeed == 0 ? 1 : maxSpeed);
        }
    }
}

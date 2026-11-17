package com.lifeline.routing.graph;

import java.util.Arrays;
import java.util.Optional;

/**
 * Time-optimal A* search. The heuristic is straight-line distance divided by
 * the fastest speed in the graph, which never overestimates remaining travel
 * time, so the result is identical to Dijkstra while expanding far fewer nodes.
 */
public final class AStar {

    public record Path(int[] nodes, double seconds, double metres, int expanded) {
    }

    private AStar() {
    }

    public static Optional<Path> shortestPath(RoadGraph g, int source, int target) {
        return search(g, source, target, true);
    }

    /** Plain Dijkstra (zero heuristic); used to validate A* in tests. */
    public static Optional<Path> dijkstra(RoadGraph g, int source, int target) {
        return search(g, source, target, false);
    }

    private static Optional<Path> search(RoadGraph g, int source, int target, boolean useHeuristic) {
        int n = g.size();
        if (source < 0 || target < 0 || source >= n || target >= n) return Optional.empty();
        if (source == target) return Optional.of(new Path(new int[]{source}, 0, 0, 0));

        double[] dist = new double[n];
        double[] metres = new double[n];
        int[] prev = new int[n];
        boolean[] closed = new boolean[n];
        Arrays.fill(dist, Double.POSITIVE_INFINITY);
        Arrays.fill(prev, -1);

        double tLat = g.lat(target);
        double tLng = g.lng(target);
        double vmax = g.maxSpeedMps();

        MinHeap open = new MinHeap(Math.max(16, n / 4));
        dist[source] = 0;
        open.push(source, useHeuristic ? Geo.haversine(g.lat(source), g.lng(source), tLat, tLng) / vmax : 0);
        int expanded = 0;

        while (!open.isEmpty()) {
            int u = open.pop();
            if (closed[u]) continue; // stale heap entry (lazy decrease-key)
            closed[u] = true;
            expanded++;
            if (u == target) break;

            for (int e = g.edgeStart(u); e < g.edgeEnd(u); e++) {
                int v = g.target(e);
                if (closed[v]) continue;
                double nd = dist[u] + g.travelSeconds(e);
                if (nd < dist[v]) {
                    dist[v] = nd;
                    metres[v] = metres[u] + g.length(e);
                    prev[v] = u;
                    double h = useHeuristic ? Geo.haversine(g.lat(v), g.lng(v), tLat, tLng) / vmax : 0;
                    open.push(v, nd + h);
                }
            }
        }

        if (prev[target] < 0) return Optional.empty();
        int len = 0;
        for (int v = target; v != -1; v = prev[v]) len++;
        int[] path = new int[len];
        for (int v = target, i = len - 1; v != -1; v = prev[v], i--) path[i] = v;
        return Optional.of(new Path(path, dist[target], metres[target], expanded));
    }

    /** Binary min-heap over (node, priority) pairs stored in primitive arrays. */
    static final class MinHeap {
        private int[] nodes;
        private double[] keys;
        private int size;

        MinHeap(int capacity) {
            nodes = new int[capacity];
            keys = new double[capacity];
        }

        boolean isEmpty() {
            return size == 0;
        }

        void push(int node, double key) {
            if (size == nodes.length) {
                nodes = Arrays.copyOf(nodes, size * 2);
                keys = Arrays.copyOf(keys, size * 2);
            }
            int i = size++;
            while (i > 0) {
                int p = (i - 1) >>> 1;
                if (keys[p] <= key) break;
                nodes[i] = nodes[p];
                keys[i] = keys[p];
                i = p;
            }
            nodes[i] = node;
            keys[i] = key;
        }

        int pop() {
            int top = nodes[0];
            size--;
            if (size > 0) {
                int node = nodes[size];
                double key = keys[size];
                int i = 0;
                while (true) {
                    int l = 2 * i + 1;
                    if (l >= size) break;
                    int c = (l + 1 < size && keys[l + 1] < keys[l]) ? l + 1 : l;
                    if (keys[c] >= key) break;
                    nodes[i] = nodes[c];
                    keys[i] = keys[c];
                    i = c;
                }
                nodes[i] = node;
                keys[i] = key;
            }
            return top;
        }
    }
}

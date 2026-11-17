package com.lifeline.routing.graph;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AStarTest {

    /** Grid like the seeded network: arterials every 5th row/column, random closures. */
    private static RoadGraph grid(int side, long seed, double closureRate) {
        Random rnd = new Random(seed);
        RoadGraph.Builder b = RoadGraph.builder();
        for (int r = 0; r < side; r++)
            for (int c = 0; c < side; c++)
                b.node(r * side + c, 42.30 + r * 0.0025, -71.15 + c * 0.0038);
        for (int r = 0; r < side; r++) {
            for (int c = 0; c < side; c++) {
                int id = r * side + c;
                if (c + 1 < side) addTwoWay(b, id, id + 1, 300, r % 5 == 0 ? 50 : 30, rnd, closureRate);
                if (r + 1 < side) addTwoWay(b, id, id + side, 280, c % 5 == 0 ? 50 : 30, rnd, closureRate);
            }
        }
        return b.build();
    }

    private static void addTwoWay(RoadGraph.Builder b, int a, int c, double len, double speed, Random rnd, double closure) {
        if (speed < 50 && rnd.nextDouble() < closure) return;
        b.edge(a, c, len, speed).edge(c, a, len, speed);
    }

    @Test
    void findsShortestPathOnSmallGraph() {
        // 0 -> 1 -> 3 is fast; 0 -> 2 -> 3 is shorter but slow.
        RoadGraph g = RoadGraph.builder()
                .node(0, 0, 0).node(1, 0, 0.01).node(2, 0.005, 0.005).node(3, 0, 0.02)
                .edge(0, 1, 1000, 100).edge(1, 3, 1000, 100)
                .edge(0, 2, 700, 10).edge(2, 3, 700, 10)
                .build();
        AStar.Path p = AStar.shortestPath(g, 0, 3).orElseThrow();
        assertArrayEquals(new int[]{0, 1, 3}, p.nodes());
        assertEquals(2000, p.metres(), 1e-9);
        assertEquals(72.0, p.seconds(), 1e-6);
    }

    @Test
    void returnsEmptyWhenUnreachable() {
        RoadGraph g = RoadGraph.builder().node(0, 0, 0).node(1, 1, 1).edge(1, 0, 10, 30).build();
        assertTrue(AStar.shortestPath(g, 0, 1).isEmpty());
    }

    @Test
    void matchesDijkstraAndExpandsFewerNodes() {
        RoadGraph g = grid(40, 7, 0.05);
        Random rnd = new Random(11);
        long astarExpanded = 0, dijkstraExpanded = 0;
        for (int i = 0; i < 200; i++) {
            int s = rnd.nextInt(g.size());
            int t = rnd.nextInt(g.size());
            var a = AStar.shortestPath(g, s, t);
            var d = AStar.dijkstra(g, s, t);
            assertEquals(d.isPresent(), a.isPresent());
            if (a.isEmpty()) continue;
            assertEquals(d.get().seconds(), a.get().seconds(), 1e-6, "A* must be optimal");
            astarExpanded += a.get().expanded();
            dijkstraExpanded += d.get().expanded();
        }
        assertTrue(astarExpanded < dijkstraExpanded, "heuristic should prune the search");
    }

    @Test
    void snapsToNearestNode() {
        RoadGraph g = grid(40, 3, 0);
        int idx = g.nearestNode(42.30 + 10 * 0.0025 + 0.0003, -71.15 + 20 * 0.0038 - 0.0004);
        assertEquals(10 * 40 + 20, g.externalId(idx));
    }
}

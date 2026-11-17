package com.lifeline.routing.service;

import com.lifeline.routing.graph.AStar;
import com.lifeline.routing.graph.Geo;
import com.lifeline.routing.graph.GraphRepository;
import com.lifeline.routing.graph.RoadGraph;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class RoutingService {

    /** Speed assumed for the off-network legs between a point and its snapped road node. */
    private static final double ACCESS_SPEED_MPS = Geo.kphToMps(20);

    public record LatLng(double lat, double lng) {
    }

    public record Route(double distanceMeters, double durationSeconds, List<LatLng> path, int nodesExpanded, double computeMillis) {
    }

    public record FacilityOption(int id, String name, String type, String address, double lat, double lng,
                                 int waitMinutes, double straightLineKm, Route route, double totalMinutes) {
    }

    public static class NoRouteException extends RuntimeException {
        public NoRouteException(String message) {
            super(message);
        }
    }

    private final GraphRepository graphs;
    private final JdbcTemplate jdbc;
    private final Map<Long, AStar.Path> cache;

    public RoutingService(GraphRepository graphs, JdbcTemplate jdbc, @Value("${routing.cache-size:5000}") int cacheSize) {
        this.graphs = graphs;
        this.jdbc = jdbc;
        // Bounded LRU of node-pair -> path. Facilities are fixed, so repeated
        // "nearest ER" lookups from the same neighbourhood are cache hits.
        this.cache = Collections.synchronizedMap(new LinkedHashMap<>(256, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Long, AStar.Path> eldest) {
                return size() > cacheSize;
            }
        });
    }

    public Route route(double fromLat, double fromLng, double toLat, double toLng) {
        long t0 = System.nanoTime();
        RoadGraph g = graphs.graph();
        if (g.size() == 0) throw new NoRouteException("road graph not loaded");

        int s = g.nearestNode(fromLat, fromLng);
        int t = g.nearestNode(toLat, toLng);
        AStar.Path p = cachedPath(g, s, t)
                .orElseThrow(() -> new NoRouteException("no route between the given points"));

        double accessIn = Geo.haversine(fromLat, fromLng, g.lat(s), g.lng(s));
        double accessOut = Geo.haversine(g.lat(t), g.lng(t), toLat, toLng);

        List<LatLng> path = new ArrayList<>(p.nodes().length + 2);
        path.add(new LatLng(fromLat, fromLng));
        for (int n : p.nodes()) path.add(new LatLng(g.lat(n), g.lng(n)));
        path.add(new LatLng(toLat, toLng));

        double metres = p.metres() + accessIn + accessOut;
        double seconds = p.seconds() + (accessIn + accessOut) / ACCESS_SPEED_MPS;
        double ms = (System.nanoTime() - t0) / 1e6;
        return new Route(round(metres, 1), round(seconds, 1), path, p.expanded(), round(ms, 3));
    }

    private Optional<AStar.Path> cachedPath(RoadGraph g, int s, int t) {
        long key = ((long) System.identityHashCode(g) << 42) ^ ((long) s << 21) ^ t;
        AStar.Path hit = cache.get(key);
        if (hit != null) return Optional.of(hit);
        Optional<AStar.Path> p = AStar.shortestPath(g, s, t);
        p.ifPresent(v -> cache.put(key, v));
        return p;
    }

    /**
     * Rank facilities by door-to-door time: road travel time (A*) plus the
     * facility's live ER wait. PostGIS KNN narrows candidates first so we only
     * run A* for a handful of plausible facilities.
     */
    public List<FacilityOption> nearest(double lat, double lng, String specialty, String type, int k) {
        int limit = Math.max(k * 3, 8);
        StringBuilder sql = new StringBuilder(
                "SELECT id, name, type, address, current_wait_minutes, " +
                "ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, " +
                "ST_Distance(location, ST_MakePoint(?, ?)::geography) / 1000.0 AS km " +
                "FROM facilities WHERE true");
        List<Object> args = new ArrayList<>(List.of(lng, lat));
        if (specialty != null && !specialty.isBlank()) {
            sql.append(" AND ? = ANY(specialties)");
            args.add(specialty);
        }
        if (type != null && !type.isBlank()) {
            sql.append(" AND type = ?");
            args.add(type);
        }
        sql.append(" ORDER BY location <-> ST_MakePoint(?, ?)::geography LIMIT ?");
        args.add(lng);
        args.add(lat);
        args.add(limit);

        List<Object[]> rows = jdbc.query(sql.toString(), (rs, i) -> new Object[]{
                rs.getInt("id"), rs.getString("name"), rs.getString("type"), rs.getString("address"),
                rs.getInt("current_wait_minutes"), rs.getDouble("lat"), rs.getDouble("lng"), rs.getDouble("km")
        }, args.toArray());

        List<FacilityOption> options = new ArrayList<>();
        for (Object[] r : rows) {
            double fLat = (double) r[5];
            double fLng = (double) r[6];
            Route route;
            try {
                route = route(lat, lng, fLat, fLng);
            } catch (NoRouteException e) {
                continue;
            }
            String fType = (String) r[2];
            int wait = "clinic".equals(fType) ? 0 : (int) r[4];
            double total = route.durationSeconds() / 60.0 + wait;
            options.add(new FacilityOption((int) r[0], (String) r[1], fType, (String) r[3], fLat, fLng,
                    wait, round((double) r[7], 2), route, round(total, 1)));
        }
        options.sort(Comparator.comparingDouble(FacilityOption::totalMinutes));
        return options.subList(0, Math.min(k, options.size()));
    }

    public Map<String, Object> stats() {
        RoadGraph g = graphs.graph();
        return Map.of("nodes", g.size(), "edges", g.edgeCount(), "cachedRoutes", cache.size());
    }

    public void clearCache() {
        cache.clear();
    }

    private static double round(double v, int places) {
        double f = Math.pow(10, places);
        return Math.round(v * f) / f;
    }
}

package com.lifeline.routing.graph;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Loads the road network from Postgres into memory. Requests read the current
 * graph through an AtomicReference, so a reload swaps graphs without locking
 * or interrupting in-flight searches.
 */
@Component
public class GraphRepository implements HealthIndicator {
    private static final Logger log = LoggerFactory.getLogger(GraphRepository.class);

    private final JdbcTemplate jdbc;
    private final AtomicReference<RoadGraph> current = new AtomicReference<>(RoadGraph.builder().build());

    public GraphRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void loadOnStartup() {
        // The database may still be initialising (first boot runs the seed
        // scripts), so retry in the background rather than failing startup.
        Thread loader = new Thread(() -> {
            for (int attempt = 1; attempt <= 60; attempt++) {
                try {
                    if (reload().size() > 0) return;
                    log.warn("Road graph is empty (attempt {}), retrying", attempt);
                } catch (Exception e) {
                    log.warn("Graph load failed (attempt {}): {}", attempt, e.getMessage());
                }
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            log.error("Giving up loading road graph; POST /api/routing/graph/reload to retry");
        }, "graph-loader");
        loader.setDaemon(true);
        loader.start();
    }

    public RoadGraph reload() {
        long t0 = System.nanoTime();
        RoadGraph.Builder b = RoadGraph.builder();
        jdbc.query("SELECT id, lat, lng FROM road_nodes",
                rs -> {
                    b.node(rs.getInt(1), rs.getDouble(2), rs.getDouble(3));
                });
        jdbc.query("SELECT from_node, to_node, length_m, speed_kph FROM road_edges",
                rs -> {
                    b.edge(rs.getInt(1), rs.getInt(2), rs.getDouble(3), rs.getDouble(4));
                });
        RoadGraph g = b.build();
        current.set(g);
        log.info("Loaded road graph: {} nodes, {} edges in {} ms", g.size(), g.edgeCount(), (System.nanoTime() - t0) / 1_000_000);
        return g;
    }

    public RoadGraph graph() {
        return current.get();
    }

    @Override
    public Health health() {
        RoadGraph g = current.get();
        return (g.size() > 0 ? Health.up() : Health.outOfService())
                .withDetail("nodes", g.size())
                .withDetail("edges", g.edgeCount())
                .build();
    }
}

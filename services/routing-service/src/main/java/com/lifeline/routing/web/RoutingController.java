package com.lifeline.routing.web;

import com.lifeline.routing.graph.GraphRepository;
import com.lifeline.routing.service.RoutingService;
import com.lifeline.routing.service.RoutingService.FacilityOption;
import com.lifeline.routing.service.RoutingService.NoRouteException;
import com.lifeline.routing.service.RoutingService.Route;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/routing")
public class RoutingController {

    private final RoutingService routing;
    private final GraphRepository graphs;

    public RoutingController(RoutingService routing, GraphRepository graphs) {
        this.routing = routing;
        this.graphs = graphs;
    }

    @GetMapping("/route")
    public Route route(@RequestParam double fromLat, @RequestParam double fromLng,
                       @RequestParam double toLat, @RequestParam double toLng) {
        validate(fromLat, fromLng);
        validate(toLat, toLng);
        return routing.route(fromLat, fromLng, toLat, toLng);
    }

    @GetMapping("/nearest")
    public Map<String, Object> nearest(@RequestParam double lat, @RequestParam double lng,
                                       @RequestParam(required = false) String specialty,
                                       @RequestParam(required = false) String type,
                                       @RequestParam(defaultValue = "3") int k) {
        validate(lat, lng);
        if (k < 1 || k > 20) throw new IllegalArgumentException("k must be between 1 and 20");
        long t0 = System.nanoTime();
        List<FacilityOption> options = routing.nearest(lat, lng, specialty, type, k);
        return Map.of(
                "origin", Map.of("lat", lat, "lng", lng),
                "options", options,
                "computeMillis", Math.round((System.nanoTime() - t0) / 1e4) / 100.0);
    }

    @GetMapping("/graph")
    public Map<String, Object> graphStats() {
        return routing.stats();
    }

    @PostMapping("/graph/reload")
    public Map<String, Object> reload() {
        graphs.reload();
        routing.clearCache();
        return routing.stats();
    }

    private static void validate(double lat, double lng) {
        if (!Double.isFinite(lat) || lat < -90 || lat > 90) throw new IllegalArgumentException("invalid latitude");
        if (!Double.isFinite(lng) || lng < -180 || lng > 180) throw new IllegalArgumentException("invalid longitude");
    }

    @ExceptionHandler({IllegalArgumentException.class, MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String, String>> badRequest(Exception e) {
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    }

    @ExceptionHandler(NoRouteException.class)
    public ResponseEntity<Map<String, String>> noRoute(NoRouteException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", e.getMessage()));
    }
}

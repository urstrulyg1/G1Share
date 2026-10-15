package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"
)

// healthHandler reports liveness: the process is serving HTTP.
func healthHandler(w http.ResponseWriter, _ *http.Request) {
	writeHealth(w, http.StatusOK, "ok")
}

// readinessHandler reports readiness: the broker can persist its registry.
func readinessHandler(broker *Broker) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if err := broker.readiness(); err != nil {
			writeHealth(w, http.StatusServiceUnavailable, "not_ready")
			return
		}
		writeHealth(w, http.StatusOK, "ready")
	}
}

func writeHealth(w http.ResponseWriter, status int, state string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(healthResponse{Status: state, Service: "opendesk-signaling", Version: serviceVersion})
}

func newServer(addr string) *http.Server {
	broker, _ := newBroker("", turnSettings{})
	return newServerWithBroker(addr, broker)
}

func newServerWithBroker(addr string, broker *Broker) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthHandler)
	mux.HandleFunc("GET /readyz", readinessHandler(broker))
	mux.HandleFunc("POST /api/v1/challenge", handleChallenge(broker))
	mux.HandleFunc("/api/v1/", handleAPI(broker))
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		writeAPIError(w, newFault(http.StatusNotFound, "not_found", "Endpoint was not found."))
	})
	return &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       12 * time.Second,
		WriteTimeout:      32 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, request)
	})
}

func getEnv(primary, fallback string) string {
	if val := strings.TrimSpace(os.Getenv(primary)); val != "" {
		return val
	}
	return strings.TrimSpace(os.Getenv(fallback))
}

func turnSettingsFromEnvironment() turnSettings {
	turn := turnSettings{
		STUNURLs:      splitURLs(getEnv("G1VIEWER_STUN_URLS", "OPENDESK_STUN_URLS"), "stun:", "stuns:"),
		TURNURLs:      splitURLs(getEnv("G1VIEWER_TURN_URLS", "OPENDESK_TURN_URLS"), "turn:", "turns:"),
		SharedSecret:  getEnv("G1VIEWER_TURN_SHARED_SECRET", "OPENDESK_TURN_SHARED_SECRET"),
		Realm:         getEnv("G1VIEWER_TURN_REALM", "OPENDESK_TURN_REALM"),
		CredentialTTL: 10 * time.Minute,
	}
	if value := getEnv("G1VIEWER_TURN_CREDENTIAL_TTL", "OPENDESK_TURN_CREDENTIAL_TTL"); value != "" {
		if duration, err := time.ParseDuration(value); err == nil && duration >= time.Minute && duration <= time.Hour {
			turn.CredentialTTL = duration
		}
	}
	return turn
}

func splitURLs(value string, allowed ...string) []string {
	urls := make([]string, 0)
	for _, candidate := range strings.Split(value, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || len(candidate) > 512 || strings.ContainsAny(candidate, " \t\r\n") {
			continue
		}
		valid := false
		for _, prefix := range allowed {
			if strings.HasPrefix(strings.ToLower(candidate), prefix) {
				valid = true
				break
			}
		}
		if valid {
			urls = append(urls, candidate)
		}
	}
	return urls
}

func dataDirectory() string {
	path := getEnv("G1VIEWER_DATA_DIR", "OPENDESK_DATA_DIR")
	if path != "" {
		return path
	}
	return "./data"
}

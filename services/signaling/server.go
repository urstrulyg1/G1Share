package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok", Service: "opendesk-signaling", Version: serviceVersion})
}

func newServer(addr string) *http.Server {
	broker, _ := newBroker("", turnSettings{})
	return newServerWithBroker(addr, broker)
}

func newServerWithBroker(addr string, broker *Broker) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthHandler)
	mux.HandleFunc("GET /readyz", healthHandler)
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

func turnSettingsFromEnvironment() turnSettings {
	turn := turnSettings{
		STUNURLs:      splitURLs(os.Getenv("OPENDESK_STUN_URLS"), "stun:", "stuns:"),
		TURNURLs:      splitURLs(os.Getenv("OPENDESK_TURN_URLS"), "turn:", "turns:"),
		SharedSecret:  strings.TrimSpace(os.Getenv("OPENDESK_TURN_SHARED_SECRET")),
		Realm:         strings.TrimSpace(os.Getenv("OPENDESK_TURN_REALM")),
		CredentialTTL: 10 * time.Minute,
	}
	if value := strings.TrimSpace(os.Getenv("OPENDESK_TURN_CREDENTIAL_TTL")); value != "" {
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

func serverAddress() string {
	address := strings.TrimSpace(os.Getenv("OPENDESK_SIGNALING_ADDR"))
	if address == "" {
		return "127.0.0.1:8787"
	}
	if _, _, err := net.SplitHostPort(address); err != nil {
		return "127.0.0.1:8787"
	}
	return address
}

func dataDirectory() string {
	path := strings.TrimSpace(os.Getenv("OPENDESK_DATA_DIR"))
	if path != "" {
		return path
	}
	return "./data"
}

func listenAndServe(server *http.Server, broker *Broker, shutdownTimeout time.Duration) error {
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go broker.cleanupLoop(ctx)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func parsePositiveInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}

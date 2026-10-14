// Command signaling currently exposes health endpoints only.
// It does not yet establish remote desktop sessions.
package main

import (
  "context"
  "encoding/json"
  "errors"
  "log"
  "net"
  "net/http"
  "os"
  "os/signal"
  "syscall"
  "time"
)

type healthResponse struct {
  Status string `json:"status"`
  Service string `json:"service"`
  Version string `json:"version"`
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
  w.Header().Set("Content-Type", "application/json; charset=utf-8")
  w.Header().Set("Cache-Control", "no-store")
  w.WriteHeader(http.StatusOK)
  _ = json.NewEncoder(w).Encode(healthResponse{Status:"ok", Service:"opendesk-signaling", Version:"0.1.0"})
}

func newServer(addr string) *http.Server {
  mux := http.NewServeMux()
  mux.HandleFunc("GET /healthz", healthHandler)
  mux.HandleFunc("GET /readyz", healthHandler)
  return &http.Server{Addr:addr, Handler:mux, ReadHeaderTimeout:3*time.Second, ReadTimeout:10*time.Second, WriteTimeout:10*time.Second, IdleTimeout:60*time.Second, MaxHeaderBytes:1<<20}
}

func main() {
  addr := os.Getenv("OPENDESK_SIGNALING_ADDR")
  if addr == "" { addr = "127.0.0.1:8787" }
  if _, _, err := net.SplitHostPort(addr); err != nil { log.Fatalf("invalid OPENDESK_SIGNALING_ADDR %q: %v", addr, err) }
  server := newServer(addr)
  ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
  defer stop()
  go func() {
    <-ctx.Done()
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := server.Shutdown(shutdownCtx); err != nil { log.Printf("graceful shutdown failed: %v", err) }
  }()
  log.Printf("OpenDesk health service listening on %s (health endpoints only)", addr)
  if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) { log.Fatalf("signaling service failed: %v", err) }
}

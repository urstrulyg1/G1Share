package main

import (
  "encoding/json"
  "net/http"
  "net/http/httptest"
  "testing"
)

func TestHealthHandler(t *testing.T) {
  req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
  rec := httptest.NewRecorder()
  healthHandler(rec, req)
  if rec.Code != http.StatusOK { t.Fatalf("status = %d, want 200", rec.Code) }
  if got := rec.Header().Get("Cache-Control"); got != "no-store" { t.Fatalf("Cache-Control = %q, want no-store", got) }
  var body healthResponse
  if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil { t.Fatalf("decode health response: %v", err) }
  if body.Status != "ok" || body.Service != "opendesk-signaling" { t.Fatalf("unexpected body: %+v", body) }
}

func TestHealthRoutes(t *testing.T) {
  server := newServer("127.0.0.1:0")
  for _, path := range []string{"/healthz", "/readyz"} {
    rec := httptest.NewRecorder()
    server.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
    if rec.Code != http.StatusOK { t.Errorf("%s status = %d, want 200", path, rec.Code) }
  }
}

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUnknownDevicePresenceHasNoInventedTimestamp(t *testing.T) {
	device := &DeviceRecord{ID: "ABCD1234-ABCD1234-ABCD1234-ABCD1234", Name: "Local device"}
	summary := summaryFor(device, time.Now())
	if summary.Online || summary.LastSeenAt != nil {
		t.Fatalf("unobserved device should be offline without a last-seen timestamp: %+v", summary)
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "lastSeenAt") {
		t.Fatalf("unknown presence must not serialize an invented timestamp: %s", encoded)
	}
}

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	healthHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if body.Status != "ok" || body.Service != "opendesk-signaling" {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestHealthRoutes(t *testing.T) {
	server := newServer("127.0.0.1:0")
	for _, path := range []string{"/healthz", "/readyz"} {
		rec := httptest.NewRecorder()
		server.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s status = %d, want 200", path, rec.Code)
		}
	}
}

func TestClientIPTrustsOnlyConfiguredProxies(t *testing.T) {
	t.Setenv("OPENDESK_TRUSTED_PROXIES", "198.51.100.0/24")

	untrusted := httptest.NewRequest(http.MethodGet, "/", nil)
	untrusted.RemoteAddr = "192.0.2.5:8443"
	untrusted.Header.Set("X-Forwarded-For", "203.0.113.7")
	if got := clientIP(untrusted); got != "192.0.2.5" {
		t.Fatalf("untrusted forwarded address = %q, want direct peer", got)
	}

	trusted := httptest.NewRequest(http.MethodGet, "/", nil)
	trusted.RemoteAddr = "198.51.100.10:8443"
	trusted.Header.Set("X-Forwarded-For", "203.0.113.9, 203.0.113.7")
	if got := clientIP(trusted); got != "203.0.113.7" {
		t.Fatalf("trusted forwarded address = %q, want the final proxy-provided client address", got)
	}
}

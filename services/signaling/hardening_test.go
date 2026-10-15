package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// pairedSession creates a pending session from viewer to host and returns its ID.
func pairedSession(t *testing.T, viewer, host *integrationClient, permissions []Permission) string {
	t.Helper()
	status, body := viewer.request(t, http.MethodPost, "/api/v1/sessions", createSessionBody{ToDeviceID: host.id, Permissions: permissions})
	if status != http.StatusCreated {
		t.Fatalf("create session: status %d: %s", status, body)
	}
	var created struct {
		Session Session `json:"session"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	return created.Session.ID
}

func TestInputAndAudioPermissionsRequireExplicitApproval(t *testing.T) {
	server := newIntegrationServer(t, nil)
	viewer := newIntegrationClient(t, server.URL)
	host := newIntegrationClient(t, server.URL)
	viewer.register(t, "Viewer")
	host.register(t, "Host")

	// The new permissions are accepted when requested explicitly.
	sessionID := pairedSession(t, viewer, host, []Permission{PermissionView, PermissionInput, PermissionAudio})

	// The host cannot approve an input grant that the viewer did not request.
	status, body := host.request(t, http.MethodPost, "/api/v1/sessions/"+sessionID+"/decision", decisionBody{
		Accepted: true, Permissions: []Permission{PermissionView, PermissionFiles},
	})
	if status != http.StatusBadRequest || !strings.Contains(string(body), "invalid_permissions") {
		t.Fatalf("escalation to unrequested files permission: status %d body %s", status, body)
	}

	// Approving a subset that includes input is allowed; the host decides, not the viewer.
	status, body = host.request(t, http.MethodPost, "/api/v1/sessions/"+sessionID+"/decision", decisionBody{
		Accepted: true, Permissions: []Permission{PermissionView, PermissionInput},
	})
	if status != http.StatusOK {
		t.Fatalf("approve view+input: status %d: %s", status, body)
	}
	var decided Session
	if err := json.Unmarshal(body, &decided); err != nil {
		t.Fatal(err)
	}
	if len(decided.Permissions) != 2 || decided.Permissions[1] != PermissionInput {
		t.Fatalf("approved permissions = %v, want [view input]", decided.Permissions)
	}
}

func TestUnknownPermissionsAreRejected(t *testing.T) {
	server := newIntegrationServer(t, nil)
	viewer := newIntegrationClient(t, server.URL)
	host := newIntegrationClient(t, server.URL)
	viewer.register(t, "Viewer")
	host.register(t, "Host")

	for _, permission := range []Permission{"shell", "camera", "View", ""} {
		status, body := viewer.request(t, http.MethodPost, "/api/v1/sessions", createSessionBody{
			ToDeviceID: host.id, Permissions: []Permission{PermissionView, permission},
		})
		if status != http.StatusBadRequest {
			t.Fatalf("permission %q accepted with status %d: %s", permission, status, body)
		}
	}
}

func TestReadinessReflectsRegistryDirectoryState(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	broker, err := newBroker(directory, turnSettings{})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newServerWithBroker("127.0.0.1:0", broker).Handler)
	t.Cleanup(server.Close)

	for _, path := range []string{"/healthz", "/readyz"} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s before data loss: status %d", path, response.StatusCode)
		}
	}

	// Removing the registry directory makes the instance unable to persist
	// registrations. Liveness stays green, readiness must go red.
	if err := os.RemoveAll(directory); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(server.URL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("/readyz after data-directory loss: status %d, want 503", response.StatusCode)
	}
	response, err = http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("/healthz should remain live: status %d", response.StatusCode)
	}
}

func TestRelayedSignalIsRejectedAfterSessionExpiry(t *testing.T) {
	broker, err := newBroker("", turnSettings{})
	if err != nil {
		t.Fatal(err)
	}
	server := newIntegrationServer(t, broker)
	viewer := newIntegrationClient(t, server.URL)
	host := newIntegrationClient(t, server.URL)
	viewer.register(t, "Viewer")
	host.register(t, "Host")
	sessionID := pairedSession(t, viewer, host, []Permission{PermissionView})
	if status, body := host.request(t, http.MethodPost, "/api/v1/sessions/"+sessionID+"/decision", decisionBody{Accepted: true, Permissions: []Permission{PermissionView}}); status != http.StatusOK {
		t.Fatalf("approve: status %d: %s", status, body)
	}

	broker.mu.Lock()
	broker.sessions[sessionID].ExpiresAt = time.Now().Add(-time.Second)
	broker.mu.Unlock()

	payload := json.RawMessage(`{"type":"offer","sdp":"v=0\r\na=ice-ufrag:x\r\na=fingerprint:sha-256 AA\r\n"}`)
	message := SignalMessage{FromDeviceID: host.id, Type: "offer", Payload: payload}
	message.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(host.private, peerSignalCanonical(sessionID, host.id, message.Type, payload)))
	status, body := host.request(t, http.MethodPost, "/api/v1/sessions/"+sessionID+"/signal", signalBody{Message: message})
	if status != http.StatusGone || !strings.Contains(string(body), "session_expired") {
		t.Fatalf("expired session signal: status %d body %s", status, body)
	}
}

func TestMalformedAndOversizedRequestsAreRejected(t *testing.T) {
	server := newIntegrationServer(t, nil)
	client := newIntegrationClient(t, server.URL)
	client.register(t, "Device")

	cases := map[string]struct {
		method string
		path   string
		body   any
		status int
	}{
		"unknown field":    {http.MethodPost, "/api/v1/devices/rename", map[string]any{"name": "x", "extra": true}, http.StatusBadRequest},
		"wrong type":       {http.MethodPost, "/api/v1/sessions", map[string]any{"toDeviceId": 5, "permissions": []string{"view"}}, http.StatusBadRequest},
		"empty body":       {http.MethodPost, "/api/v1/devices/rename", nil, http.StatusBadRequest},
		"invalid session":  {http.MethodPost, "/api/v1/sessions/not-a-session/decision", decisionBody{Accepted: false}, http.StatusNotFound},
		"invalid event id": {http.MethodGet, "/api/v1/events?after=-1&wait=0", nil, http.StatusBadRequest},
		"long poll bound":  {http.MethodGet, "/api/v1/events?after=0&wait=26", nil, http.StatusBadRequest},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			status, body := client.request(t, tc.method, tc.path, tc.body)
			if status != tc.status {
				t.Fatalf("status %d, want %d; body %s", status, tc.status, body)
			}
		})
	}

	oversized := map[string]string{"name": strings.Repeat("A", maxRequestBytes)}
	status, body := client.request(t, http.MethodPost, "/api/v1/devices/rename", oversized)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status %d: %s", status, body)
	}
}

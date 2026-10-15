package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// No user account exists: generated device keys register directly, but neither an ID
// nor someone else's valid key can approve a session or send media before consent.
func TestAccountFreeRegistrationStillRequiresDeviceConsent(t *testing.T) {
	server := newIntegrationServer(t, nil)
	viewer := newIntegrationClient(t, server.URL)
	host := newIntegrationClient(t, server.URL)
	outsider := newIntegrationClient(t, server.URL)
	viewer.register(t, "Viewer device")
	host.register(t, "Host device")
	outsider.register(t, "Other device")

	status, body := viewer.request(t, http.MethodPost, "/api/v1/sessions", createSessionBody{
		ToDeviceID: host.id, Permissions: []Permission{PermissionView, PermissionFiles, PermissionInput},
	})
	if status != http.StatusCreated {
		t.Fatalf("account-free session request: %d %s", status, body)
	}
	var created struct {
		Session Session `json:"session"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/sessions/" + created.Session.ID

	unsigned, err := http.Post(server.URL+path+"/decision", "application/json", bytes.NewBufferString(`{"accepted":true,"permissions":["view"]}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = unsigned.Body.Close()
	if unsigned.StatusCode != http.StatusUnauthorized {
		t.Fatalf("device ID without signing key approved a session: %d", unsigned.StatusCode)
	}
	status, body = outsider.request(t, http.MethodPost, path+"/decision", decisionBody{Accepted: true, Permissions: []Permission{PermissionView}})
	if status != http.StatusForbidden {
		t.Fatalf("other registered device approved a session: %d %s", status, body)
	}

	payload := json.RawMessage(`{"type":"offer","sdp":"v=0\r\na=ice-ufrag:x\r\na=fingerprint:sha-256 AA:BB\r\n"}`)
	status, body = host.request(t, http.MethodPost, path+"/signal", signalBody{Message: SignalMessage{FromDeviceID: host.id, Type: "offer", Payload: payload}})
	if status != http.StatusConflict || !strings.Contains(string(body), "session_not_accepted") {
		t.Fatalf("unapproved session forwarded video setup: %d %s", status, body)
	}
	status, body = host.request(t, http.MethodPost, path+"/decision", decisionBody{Accepted: false})
	if status != http.StatusOK {
		t.Fatalf("host rejection failed: %d %s", status, body)
	}
	status, body = host.request(t, http.MethodPost, path+"/signal", signalBody{Message: SignalMessage{FromDeviceID: host.id, Type: "offer", Payload: payload}})
	if status != http.StatusConflict {
		t.Fatalf("rejected session forwarded media setup: %d %s", status, body)
	}
}

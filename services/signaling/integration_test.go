package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type integrationClient struct {
	id        string
	publicKey string
	private   ed25519.PrivateKey
	baseURL   string
	http      *http.Client
}

func newIntegrationClient(t *testing.T, baseURL string) *integrationClient {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encodedKey := base64.RawURLEncoding.EncodeToString(publicKey)
	return &integrationClient{
		id:        deviceIDFromPublicKey(encodedKey),
		publicKey: encodedKey,
		private:   privateKey,
		baseURL:   baseURL,
		http:      &http.Client{Timeout: 5 * time.Second},
	}
}

func (client *integrationClient) register(t *testing.T, name string) DeviceSummary {
	t.Helper()
	var result DeviceSummary
	status, body := client.request(t, http.MethodPost, "/api/v1/devices/register", registerBody{
		ID: client.id, PublicKey: client.publicKey, Name: name, Platform: "linux", AppVersion: "test",
	})
	if status != http.StatusOK {
		t.Fatalf("register %s: status %d: %s", client.id, status, body)
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("decode registration: %v", err)
	}
	return result
}

func (client *integrationClient) request(t *testing.T, method, path string, value any) (int, []byte) {
	t.Helper()
	requestBody := []byte{}
	var err error
	if value != nil {
		requestBody, err = json.Marshal(value)
		if err != nil {
			t.Fatalf("encode request body: %v", err)
		}
	}
	challengeBody, err := json.Marshal(challengeRequest{DeviceID: client.id})
	if err != nil {
		t.Fatal(err)
	}
	challengeRequest, err := http.NewRequest(http.MethodPost, client.baseURL+"/api/v1/challenge", bytes.NewReader(challengeBody))
	if err != nil {
		t.Fatal(err)
	}
	challengeRequest.Header.Set("Content-Type", "application/json")
	challengeHTTPResponse, err := client.http.Do(challengeRequest)
	if err != nil {
		t.Fatalf("request challenge: %v", err)
	}
	var challenge challengeResponse
	if err := json.NewDecoder(challengeHTTPResponse.Body).Decode(&challenge); err != nil {
		_ = challengeHTTPResponse.Body.Close()
		t.Fatalf("decode challenge: %v", err)
	}
	_ = challengeHTTPResponse.Body.Close()
	if challengeHTTPResponse.StatusCode != http.StatusOK {
		t.Fatalf("challenge status %d", challengeHTTPResponse.StatusCode)
	}
	signature := ed25519.Sign(client.private, canonicalRequest(method, path, requestBody, challenge.Nonce))
	request, err := http.NewRequest(method, client.baseURL+path, bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-OD-Device-ID", client.id)
	request.Header.Set("X-OD-Nonce", challenge.Nonce)
	request.Header.Set("X-OD-Signature", base64.RawURLEncoding.EncodeToString(signature))
	response, err := client.http.Do(request)
	if err != nil {
		t.Fatalf("request %s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return response.StatusCode, body
}

func newIntegrationServer(t *testing.T, broker *Broker) *httptest.Server {
	t.Helper()
	if broker == nil {
		var err error
		broker, err = newBroker("", turnSettings{})
		if err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(newServerWithBroker("127.0.0.1:0", broker).Handler)
	t.Cleanup(server.Close)
	return server
}

func TestAuthenticatedRegistrationPairingAndSignedWebRTCSignal(t *testing.T) {
	server := newIntegrationServer(t, nil)
	viewer := newIntegrationClient(t, server.URL)
	host := newIntegrationClient(t, server.URL)
	viewer.register(t, "Viewer workstation")
	host.register(t, "Host workstation")

	status, body := viewer.request(t, http.MethodPost, "/api/v1/sessions", createSessionBody{
		ToDeviceID: host.id, Permissions: []Permission{PermissionView, PermissionFiles, PermissionClipboard},
	})
	if status != http.StatusCreated {
		t.Fatalf("create session: status %d: %s", status, body)
	}
	var created struct {
		Session Session       `json:"session"`
		Peer    DeviceSummary `json:"peer"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	if created.Session.Status != "pending" || !created.Peer.Online {
		t.Fatalf("unexpected session response: %+v", created)
	}

	status, body = host.request(t, http.MethodGet, "/api/v1/events?after=0&wait=0", nil)
	if status != http.StatusOK {
		t.Fatalf("host events: status %d: %s", status, body)
	}
	var incoming EventBatch
	if err := json.Unmarshal(body, &incoming); err != nil {
		t.Fatal(err)
	}
	if len(incoming.Events) != 1 || incoming.Events[0].Type != "session.request" || incoming.Events[0].Peer.ID != viewer.id {
		t.Fatalf("missing authenticated incoming request: %+v", incoming)
	}

	status, body = host.request(t, http.MethodPost, "/api/v1/sessions/"+created.Session.ID+"/decision", decisionBody{
		Accepted: true, Permissions: []Permission{PermissionView, PermissionFiles},
	})
	if status != http.StatusOK {
		t.Fatalf("approve session: status %d: %s", status, body)
	}
	status, body = viewer.request(t, http.MethodGet, "/api/v1/events?after=0&wait=0", nil)
	if status != http.StatusOK {
		t.Fatalf("viewer events: status %d: %s", status, body)
	}
	var accepted EventBatch
	if err := json.Unmarshal(body, &accepted); err != nil {
		t.Fatal(err)
	}
	if len(accepted.Events) != 1 || accepted.Events[0].Type != "session.accepted" {
		t.Fatalf("missing approval event: %+v", accepted)
	}
	if got := accepted.Events[0].Session.Permissions; len(got) != 2 || got[0] != PermissionView || got[1] != PermissionFiles {
		t.Fatalf("host permission selection was not enforced: %v", got)
	}

	payload := json.RawMessage(`{"type":"offer","sdp":"v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:abc123\r\na=fingerprint:sha-256 AA:BB:CC\r\n"}`)
	message := SignalMessage{FromDeviceID: host.id, Type: "offer", Payload: payload}
	message.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(host.private, peerSignalCanonical(created.Session.ID, host.id, message.Type, payload)))
	status, body = host.request(t, http.MethodPost, "/api/v1/sessions/"+created.Session.ID+"/signal", signalBody{Message: message})
	if status != http.StatusAccepted {
		t.Fatalf("forward signed offer: status %d: %s", status, body)
	}
	status, body = viewer.request(t, http.MethodGet, "/api/v1/events?after=1&wait=0", nil)
	if status != http.StatusOK {
		t.Fatalf("read offer event: status %d: %s", status, body)
	}
	var signalEvents EventBatch
	if err := json.Unmarshal(body, &signalEvents); err != nil {
		t.Fatal(err)
	}
	if len(signalEvents.Events) != 1 || signalEvents.Events[0].Type != "signal" || signalEvents.Events[0].Message.Type != "offer" {
		t.Fatalf("signed offer was not routed: %+v", signalEvents)
	}

	message.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	status, body = host.request(t, http.MethodPost, "/api/v1/sessions/"+created.Session.ID+"/signal", signalBody{Message: message})
	if status != http.StatusUnauthorized || !strings.Contains(string(body), "invalid_peer_signature") {
		t.Fatalf("forged peer signal status = %d, body = %s", status, body)
	}

	status, body = viewer.request(t, http.MethodPost, "/api/v1/sessions/"+created.Session.ID+"/signal", signalBody{Message: SignalMessage{
		FromDeviceID: viewer.id, Type: "offer", Payload: payload,
	}})
	if status != http.StatusForbidden || !strings.Contains(string(body), "invalid_signal_role") {
		t.Fatalf("viewer should not be allowed to offer: status %d body %s", status, body)
	}

	status, body = viewer.request(t, http.MethodPost, "/api/v1/sessions/"+created.Session.ID+"/close", closeBody{Reason: "user disconnected"})
	if status != http.StatusOK {
		t.Fatalf("close session: status %d: %s", status, body)
	}
	status, body = host.request(t, http.MethodGet, "/api/v1/events?after=1&wait=0", nil)
	if status != http.StatusOK {
		t.Fatalf("host close event: status %d: %s", status, body)
	}
	var closed EventBatch
	if err := json.Unmarshal(body, &closed); err != nil {
		t.Fatal(err)
	}
	if len(closed.Events) != 1 || closed.Events[0].Type != "session.closed" {
		t.Fatalf("missing close event: %+v", closed)
	}
}

func TestAuthenticationRejectsReplayTamperingAndUnregisteredRequests(t *testing.T) {
	server := newIntegrationServer(t, nil)
	client := newIntegrationClient(t, server.URL)
	client.register(t, "Test device")

	challengeBody, _ := json.Marshal(challengeRequest{DeviceID: client.id})
	response, err := client.http.Post(server.URL+"/api/v1/challenge", "application/json", bytes.NewReader(challengeBody))
	if err != nil {
		t.Fatal(err)
	}
	var challenge challengeResponse
	if err := json.NewDecoder(response.Body).Decode(&challenge); err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	requestBody := []byte(`{"name":"forged"}`)
	signature := ed25519.Sign(client.private, canonicalRequest(http.MethodPost, "/api/v1/devices/rename", requestBody, challenge.Nonce))
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/devices/rename", bytes.NewReader([]byte(`{"name":"changed"}`)))
	request.Header.Set("X-OD-Device-ID", client.id)
	request.Header.Set("X-OD-Nonce", challenge.Nonce)
	request.Header.Set("X-OD-Signature", base64.RawURLEncoding.EncodeToString(signature))
	response, err = client.http.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("tampered body status = %d, want 401", response.StatusCode)
	}
	_ = response.Body.Close()

	status, body := client.request(t, http.MethodPost, "/api/v1/devices/rename", renameBody{Name: "Renamed"})
	if status != http.StatusOK {
		t.Fatalf("new challenge after tampering should work: %d %s", status, body)
	}

	unknown := newIntegrationClient(t, server.URL)
	status, body = unknown.request(t, http.MethodGet, "/api/v1/devices/me", nil)
	if status != http.StatusUnauthorized || !strings.Contains(string(body), "device_not_registered") {
		t.Fatalf("unregistered API request status = %d body = %s", status, body)
	}
}

func TestRegistrationPinsIdentityAndRejectsModernIDMismatch(t *testing.T) {
	server := newIntegrationServer(t, nil)
	owner := newIntegrationClient(t, server.URL)
	owner.register(t, "Owner")

	attacker := newIntegrationClient(t, server.URL)
	attacker.id = owner.id
	status, body := attacker.request(t, http.MethodPost, "/api/v1/devices/register", registerBody{
		ID: attacker.id, PublicKey: attacker.publicKey, Name: "Impersonator", Platform: "linux", AppVersion: "test",
	})
	if status != http.StatusConflict && status != http.StatusBadRequest {
		t.Fatalf("identity conflict status = %d body = %s", status, body)
	}

	mismatch := newIntegrationClient(t, server.URL)
	mismatch.id = "AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD"
	status, body = mismatch.request(t, http.MethodPost, "/api/v1/devices/register", registerBody{
		ID: mismatch.id, PublicKey: mismatch.publicKey, Name: "Mismatch", Platform: "linux", AppVersion: "test",
	})
	if status != http.StatusBadRequest || !strings.Contains(string(body), "device_key_mismatch") {
		t.Fatalf("modern ID/key mismatch status = %d body = %s", status, body)
	}
}

func TestRegistrationPersistsAndRevocationPreventsReuse(t *testing.T) {
	dir := t.TempDir()
	serverBroker, err := newBroker(dir, turnSettings{})
	if err != nil {
		t.Fatal(err)
	}
	server := newIntegrationServer(t, serverBroker)
	client := newIntegrationClient(t, server.URL)
	client.register(t, "Persistent")

	registryPath := filepath.Join(dir, "device-registry.json")
	info, err := os.Stat(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("registry permissions are too broad: %o", info.Mode().Perm())
	}
	loaded, err := newBroker(dir, turnSettings{})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := loaded.registeredDevice(client.id); !ok {
		t.Fatal("registered key was not restored")
	}

	status, body := client.request(t, http.MethodPost, "/api/v1/devices/revoke", map[string]any{})
	if status != http.StatusOK {
		t.Fatalf("revoke device: %d %s", status, body)
	}
	status, body = client.request(t, http.MethodPost, "/api/v1/devices/register", registerBody{
		ID: client.id, PublicKey: client.publicKey, Name: "Persistent", Platform: "linux", AppVersion: "test",
	})
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		t.Fatalf("revoked key should not authenticate again: %d %s", status, body)
	}
}

func TestSessionApprovalRejectsEscalationAndTargetOffline(t *testing.T) {
	server := newIntegrationServer(t, nil)
	viewer := newIntegrationClient(t, server.URL)
	host := newIntegrationClient(t, server.URL)
	viewer.register(t, "Viewer")
	host.register(t, "Host")
	status, body := viewer.request(t, http.MethodPost, "/api/v1/sessions", createSessionBody{ToDeviceID: host.id, Permissions: []Permission{PermissionView}})
	if status != http.StatusCreated {
		t.Fatalf("create session: %d %s", status, body)
	}
	var response struct {
		Session Session `json:"session"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	status, body = host.request(t, http.MethodPost, "/api/v1/sessions/"+response.Session.ID+"/decision", decisionBody{Accepted: true, Permissions: []Permission{PermissionView, PermissionFiles}})
	if status != http.StatusBadRequest {
		t.Fatalf("permission escalation status = %d body = %s", status, body)
	}
	status, body = viewer.request(t, http.MethodPost, "/api/v1/sessions", createSessionBody{ToDeviceID: host.id, Permissions: []Permission{PermissionView}})
	if status != http.StatusConflict {
		t.Fatalf("duplicate session status = %d body = %s", status, body)
	}

	status, body = host.request(t, http.MethodPost, "/api/v1/sessions/"+response.Session.ID+"/decision", decisionBody{Accepted: false})
	if status != http.StatusOK {
		t.Fatalf("reject session: %d %s", status, body)
	}
	var rejected Session
	if err := json.Unmarshal(body, &rejected); err != nil || rejected.Status != "rejected" {
		t.Fatalf("session wasn't rejected: %+v %v", rejected, err)
	}
}

func TestEventLongPollWakesAndReportsOverflow(t *testing.T) {
	broker, err := newBroker("", turnSettings{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan EventBatch, 1)
	go func() {
		batch, _ := broker.pollEvents(ctx, "ABCD-EF01-2345", 0, time.Second)
		result <- batch
	}()
	time.Sleep(20 * time.Millisecond)
	broker.mu.Lock()
	broker.emitLocked("ABCD-EF01-2345", ServerEvent{Type: "test.event"})
	broker.mu.Unlock()
	select {
	case batch := <-result:
		if len(batch.Events) != 1 || batch.Events[0].Type != "test.event" {
			t.Fatalf("unexpected long-poll result: %+v", batch)
		}
	case <-time.After(time.Second):
		t.Fatal("long-poll didn't wake after an event was queued")
	}

	broker.mu.Lock()
	for index := 0; index < maxEventsPerDevice+4; index++ {
		broker.emitLocked("ABCD-EF01-2345", ServerEvent{Type: "overflow.test"})
	}
	broker.mu.Unlock()
	batch, err := broker.pollEvents(context.Background(), "ABCD-EF01-2345", 1, 0)
	if err != nil || !batch.Overflow || len(batch.Events) != maxEventsPerDevice {
		t.Fatalf("overflow not signaled: events=%d overflow=%v err=%v", len(batch.Events), batch.Overflow, err)
	}
}

func TestTurnCredentialsUseShortLivedCoturnRESTHMAC(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	broker, err := newBroker("", turnSettings{
		STUNURLs: []string{"stun:stun.test:3478"}, TURNURLs: []string{"turn:turn.test:3478?transport=udp"},
		SharedSecret: "local-test-secret", CredentialTTL: 10 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	configuration := broker.iceConfiguration("ABCDEF01-23456789-ABCDEF01-23456789", now)
	if len(configuration.ICEServers) != 2 || configuration.ICEServers[0].URLs[0] != "stun:stun.test:3478" {
		t.Fatalf("unexpected ICE configuration: %+v", configuration)
	}
	turn := configuration.ICEServers[1]
	if !strings.HasPrefix(turn.Username, fmt.Sprintf("%d:", now.Add(10*time.Minute).Unix())) || turn.Credential == "" {
		t.Fatalf("missing expiring TURN credentials: %+v", turn)
	}
	mac := hmacForTest("local-test-secret", turn.Username)
	if turn.Credential != mac {
		t.Fatalf("TURN REST credential mismatch: got %q want %q", turn.Credential, mac)
	}
}

func hmacForTest(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestAuthenticatedDeviceCollectionListsOnlineDevices(t *testing.T) {
	server := newIntegrationServer(t, nil)
	viewer := newIntegrationClient(t, server.URL)
	host := newIntegrationClient(t, server.URL)
	viewer.register(t, "Viewer workstation")
	host.register(t, "Host workstation")

	status, body := viewer.request(t, http.MethodGet, "/api/v1/devices", nil)
	if status != http.StatusOK {
		t.Fatalf("list devices: status %d: %s", status, body)
	}
	var response struct {
		Devices []DeviceSummary `json:"devices"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode device collection: %v", err)
	}
	seen := map[string]bool{}
	for _, device := range response.Devices {
		if !device.Online {
			t.Errorf("offline device %s included in online collection", device.ID)
		}
		seen[device.ID] = true
	}
	if !seen[viewer.id] || !seen[host.id] {
		t.Fatalf("device collection missing registered online peers: viewer=%v host=%v devices=%+v", seen[viewer.id], seen[host.id], response.Devices)
	}

	if status, body = host.request(t, http.MethodPost, "/api/v1/devices/revoke", map[string]any{}); status != http.StatusOK {
		t.Fatalf("revoke host identity: status %d: %s", status, body)
	}
	status, body = viewer.request(t, http.MethodGet, "/api/v1/devices", nil)
	if status != http.StatusOK {
		t.Fatalf("list devices after revocation: status %d: %s", status, body)
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	for _, device := range response.Devices {
		if device.ID == host.id {
			t.Fatal("revoked device must not appear in device collection")
		}
	}
}

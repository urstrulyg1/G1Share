package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPublicTURNCredentialsAreShortLivedAndSigned(t *testing.T) {
	const secret = "test-only-turn-secret"
	broker, err := newBroker("", turnSettings{
		TURNURLs: []string{"turn:turn.example.invalid:3478?transport=udp"},
		SharedSecret: secret,
		CredentialTTL: 5 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newServerWithBroker("127.0.0.1:0", broker).Handler)
	defer server.Close()

	response, err := http.Get(server.URL + "/api/v1/turn-credentials")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.StatusCode)
	}
	var result publicTURNCredentialsResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.ICEServers) != 1 {
		t.Fatalf("expected one TURN server, got %d", len(result.ICEServers))
	}
	serverConfig := result.ICEServers[0]
	if len(serverConfig.URLs) != 1 || serverConfig.URLs[0] != "turn:turn.example.invalid:3478?transport=udp" {
		t.Fatalf("unexpected TURN URLs: %#v", serverConfig.URLs)
	}
	if serverConfig.Username == "" || serverConfig.Credential == "" {
		t.Fatal("expected temporary TURN username and credential")
	}
	expiresUnix, err := parseTURNCredentialExpiry(serverConfig.Username)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExpiresAt.Unix() != expiresUnix || time.Until(result.ExpiresAt) <= 0 || time.Until(result.ExpiresAt) > 5*time.Minute {
		t.Fatalf("unexpected expiry: username=%d response=%s", expiresUnix, result.ExpiresAt)
	}
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(serverConfig.Username))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(serverConfig.Credential)) {
		t.Fatal("TURN credential does not match Coturn REST authentication")
	}
	body, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), secret) {
		t.Fatal("TURN shared secret leaked in the public response")
	}
}

func parseTURNCredentialExpiry(username string) (int64, error) {
	separator := strings.IndexByte(username, ':')
	if separator <= 0 {
		return 0, fmt.Errorf("invalid TURN username")
	}
	var expiry int64
	_, err := fmt.Sscanf(username[:separator], "%d", &expiry)
	if err != nil {
		return 0, err
	}
	return expiry, nil
}

func TestPublicTURNCredentialsRequireConfiguration(t *testing.T) {
	broker, err := newBroker("", turnSettings{})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newServerWithBroker("127.0.0.1:0", broker).Handler)
	defer server.Close()
	response, err := http.Get(server.URL + "/api/v1/turn-credentials")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when TURN is unconfigured, got %d", response.StatusCode)
	}
}

func TestPublicTURNCredentialsRateLimit(t *testing.T) {
	broker, err := newBroker("", turnSettings{TURNURLs: []string{"turn:turn.example.invalid:3478"}, SharedSecret: "test-only-secret"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newServerWithBroker("127.0.0.1:0", broker).Handler)
	defer server.Close()
	for i := 0; i < 20; i++ {
		response, err := http.Get(server.URL + "/api/v1/turn-credentials")
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d", i+1, response.StatusCode)
		}
	}
	response, err := http.Get(server.URL + "/api/v1/turn-credentials")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after rate limit, got %d", response.StatusCode)
	}
}

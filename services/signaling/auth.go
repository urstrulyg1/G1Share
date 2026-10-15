package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type authenticatedDevice struct {
	ID     string
	Record *DeviceRecord
}

type registerRequest struct {
	ID        string `json:"id"`
	PublicKey string `json:"publicKey"`
}

func readRequestBody(w http.ResponseWriter, request *http.Request) ([]byte, *apiFault) {
	if request.Body == nil {
		return nil, nil
	}
	defer request.Body.Close()
	body, err := io.ReadAll(http.MaxBytesReader(w, request.Body, maxRequestBytes))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "request body too large") {
			return nil, newFault(http.StatusRequestEntityTooLarge, "request_too_large", "Request body exceeds the 512 KiB limit.")
		}
		return nil, newFault(http.StatusBadRequest, "invalid_body", "Request body could not be read.")
	}
	return body, nil
}

func authenticateRequest(broker *Broker, request *http.Request, body []byte) (authenticatedDevice, *apiFault) {
	deviceID := request.Header.Get("X-OD-Device-ID")
	nonce := request.Header.Get("X-OD-Nonce")
	encodedSignature := request.Header.Get("X-OD-Signature")
	if !validDeviceID(deviceID) || nonce == "" || encodedSignature == "" {
		return authenticatedDevice{}, newFault(http.StatusUnauthorized, "authentication_required", "A valid device ID and request signature are required.")
	}
	challenge, found := broker.consumeChallenge(nonce)
	if !found || challenge.DeviceID != deviceID {
		return authenticatedDevice{}, newFault(http.StatusUnauthorized, "invalid_challenge", "Authentication challenge is missing, expired, or already used.")
	}

	var record *DeviceRecord
	var publicKey string
	if request.URL.Path == "/api/v1/devices/register" && request.Method == http.MethodPost {
		var registration registerRequest
		if err := json.Unmarshal(body, &registration); err != nil || registration.ID != deviceID || registration.PublicKey == "" {
			return authenticatedDevice{}, newFault(http.StatusBadRequest, "invalid_registration", "Registration must contain the authenticated device ID and public key.")
		}
		var exists bool
		record, exists = broker.registeredDevice(deviceID)
		if exists {
			if record.Revoked {
				return authenticatedDevice{}, newFault(http.StatusForbidden, "device_revoked", "This device identity has been revoked.")
			}
			if !constantTimeStringEqual(record.PublicKey, registration.PublicKey) {
				return authenticatedDevice{}, newFault(http.StatusConflict, "identity_conflict", "This ID is registered to another identity key.")
			}
			publicKey = record.PublicKey
		} else {
			publicKey = registration.PublicKey
		}
	} else {
		var exists bool
		record, exists = broker.registeredDevice(deviceID)
		if !exists || record.Revoked {
			return authenticatedDevice{}, newFault(http.StatusUnauthorized, "device_not_registered", "Register this device before making authenticated requests.")
		}
		publicKey = record.PublicKey
	}

	key, err := decodePublicKey(publicKey)
	if err != nil {
		return authenticatedDevice{}, newFault(http.StatusUnauthorized, "invalid_identity_key", "The registered device key is invalid.")
	}
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return authenticatedDevice{}, newFault(http.StatusUnauthorized, "invalid_signature", "The request signature is invalid.")
	}
	canonical := canonicalRequest(request.Method, request.URL.RequestURI(), body, nonce)
	if !ed25519.Verify(key, canonical, signature) {
		return authenticatedDevice{}, newFault(http.StatusUnauthorized, "invalid_signature", "The request signature is invalid.")
	}
	if !broker.allowRate("device:"+deviceID, 600, time.Minute) {
		return authenticatedDevice{}, newFault(http.StatusTooManyRequests, "rate_limited", "This device is sending requests too quickly.")
	}
	if request.URL.Path != "/api/v1/devices/register" {
		broker.touchDevice(deviceID)
	}
	return authenticatedDevice{ID: deviceID, Record: record}, nil
}

func clientIP(request *http.Request) string {
	remoteHost, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		remoteHost = request.RemoteAddr
	}
	if zone := strings.LastIndex(remoteHost, "%"); zone >= 0 {
		remoteHost = remoteHost[:zone]
	}
	remoteIP := net.ParseIP(remoteHost)
	if remoteIP == nil {
		if remoteHost != "" {
			return remoteHost
		}
		return "unknown"
	}
	if !isTrustedProxy(remoteIP) {
		return remoteIP.String()
	}
	forwarded := strings.Split(request.Header.Get("X-Forwarded-For"), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		if address := net.ParseIP(strings.TrimSpace(forwarded[index])); address != nil {
			return address.String()
		}
	}
	return remoteIP.String()
}

func isTrustedProxy(address net.IP) bool {
	raw := strings.TrimSpace(os.Getenv("G1VIEWER_TRUSTED_PROXIES"))
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("OPENDESK_TRUSTED_PROXIES"))
	}
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if ip := net.ParseIP(value); ip != nil {
			if ip.Equal(address) {
				return true
			}
			continue
		}
		_, subnet, err := net.ParseCIDR(value)
		if err == nil && subnet.Contains(address) {
			return true
		}
	}
	return false
}

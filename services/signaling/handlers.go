package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type challengeRequest struct {
	DeviceID string `json:"deviceId"`
}

type challengeResponse struct {
	Nonce     string    `json:"nonce"`
	ExpiresAt time.Time `json:"expiresAt"`
	Version   string    `json:"protocolVersion"`
}

type registerBody struct {
	ID         string `json:"id"`
	PublicKey  string `json:"publicKey"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	AppVersion string `json:"appVersion"`
}

type renameBody struct {
	Name string `json:"name"`
}

type createSessionBody struct {
	ToDeviceID  string       `json:"toDeviceId"`
	Permissions []Permission `json:"permissions"`
}

type decisionBody struct {
	Accepted    bool         `json:"accepted"`
	Permissions []Permission `json:"permissions"`
}

type signalBody struct {
	Message SignalMessage `json:"message"`
}

type closeBody struct {
	Reason string `json:"reason"`
}

type publicTURNCredentialsResponse struct {
	ExpiresAt time.Time   `json:"expiresAt"`
	ICEServers []ICEServer `json:"iceServers"`
}

// handlePublicTURNCredentials issues short-lived credentials for the configured
// TURN service. This endpoint is intentionally unauthenticated so a fresh install
// can connect by device ID alone; strict per-client-IP throttling and a short TTL
// limit abuse. The shared TURN secret never leaves this service.
func handlePublicTURNCredentials(broker *Broker) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writeAPIError(w, newFault(http.StatusMethodNotAllowed, "method_not_allowed", "Use GET for TURN credentials."))
			return
		}
		if !broker.allowRate("turn-credentials:"+clientIP(request), 20, time.Minute) {
			writeAPIError(w, newFault(http.StatusTooManyRequests, "rate_limited", "Too many TURN credential requests. Wait a minute and try again."))
			return
		}
		server, expiresAt, fault := broker.issuePublicTURNCredentials(time.Now().UTC())
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		writeJSON(w, http.StatusOK, publicTURNCredentialsResponse{
			ExpiresAt: expiresAt,
			ICEServers: []ICEServer{server},
		})
	}
}

func handleChallenge(broker *Broker) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writeAPIError(w, newFault(http.StatusMethodNotAllowed, "method_not_allowed", "Use POST for authentication challenges."))
			return
		}
		body, fault := readRequestBody(w, request)
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		var input challengeRequest
		if fault := decodeJSON(body, &input); fault != nil {
			writeAPIError(w, fault)
			return
		}
		nonce, expiresAt, fault := broker.issueChallenge(input.DeviceID, clientIP(request))
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		writeJSON(w, http.StatusOK, challengeResponse{Nonce: nonce, ExpiresAt: expiresAt, Version: protocolVersion})
	}
}

func handleAPI(broker *Broker) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if !knownAPIPath(request.URL.Path) {
			writeAPIError(w, newFault(http.StatusNotFound, "not_found", "Endpoint was not found."))
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodPost {
			writeAPIError(w, newFault(http.StatusMethodNotAllowed, "method_not_allowed", "Only GET and POST are supported."))
			return
		}
		body, fault := readRequestBody(w, request)
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		actor, fault := authenticateRequest(broker, request, body)
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		path := request.URL.Path
		switch {
		case path == "/api/v1/devices/register" && request.Method == http.MethodPost:
			handleRegister(broker, actor, body, w)
		case path == "/api/v1/devices/heartbeat" && request.Method == http.MethodPost:
			if _, fault := broker.getDevice(actor.ID); fault != nil {
				writeAPIError(w, fault)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "serverTime": time.Now().UTC()})
		case path == "/api/v1/devices" && request.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"devices": broker.listDevices()})
		case path == "/api/v1/devices/me" && request.Method == http.MethodGet:
			device, fault := broker.getDevice(actor.ID)
			if fault != nil {
				writeAPIError(w, fault)
				return
			}
			writeJSON(w, http.StatusOK, device)
		case path == "/api/v1/devices/rename" && request.Method == http.MethodPost:
			var input renameBody
			if fault := decodeJSON(body, &input); fault != nil {
				writeAPIError(w, fault)
				return
			}
			device, fault := broker.renameDevice(actor.ID, input.Name)
			if fault != nil {
				writeAPIError(w, fault)
				return
			}
			writeJSON(w, http.StatusOK, device)
		case path == "/api/v1/devices/revoke" && request.Method == http.MethodPost:
			if fault := broker.revokeDevice(actor.ID); fault != nil {
				writeAPIError(w, fault)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"revoked": true})
		case strings.HasPrefix(path, "/api/v1/devices/") && request.Method == http.MethodGet:
			id := strings.TrimPrefix(path, "/api/v1/devices/")
			if id == "me" || id == "register" || id == "heartbeat" || id == "rename" || id == "revoke" || !validDeviceID(id) {
				writeAPIError(w, newFault(http.StatusBadRequest, "invalid_device_id", "Device ID is invalid."))
				return
			}
			device, fault := broker.getDevice(id)
			if fault != nil {
				writeAPIError(w, fault)
				return
			}
			writeJSON(w, http.StatusOK, device)
		case path == "/api/v1/sessions" && request.Method == http.MethodPost:
			var input createSessionBody
			if fault := decodeJSON(body, &input); fault != nil {
				writeAPIError(w, fault)
				return
			}
			session, peer, fault := broker.createSession(actor.ID, input.ToDeviceID, input.Permissions)
			if fault != nil {
				writeAPIError(w, fault)
				return
			}
			writeJSON(w, http.StatusCreated, map[string]any{"session": session, "peer": peer})
		case path == "/api/v1/events" && request.Method == http.MethodGet:
			handleEvents(broker, actor, request, w)
		case path == "/api/v1/ice" && request.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, broker.iceConfiguration(actor.ID, time.Now()))
		case strings.HasPrefix(path, "/api/v1/sessions/"):
			handleSessionRoute(broker, actor, request, body, w)
		default:
			writeAPIError(w, newFault(http.StatusMethodNotAllowed, "method_not_allowed", "This method is not supported for the endpoint."))
		}
	}
}

func knownAPIPath(path string) bool {
	switch path {
	case "/api/v1/devices", "/api/v1/devices/register", "/api/v1/devices/heartbeat", "/api/v1/devices/me", "/api/v1/devices/rename", "/api/v1/devices/revoke", "/api/v1/sessions", "/api/v1/events", "/api/v1/ice":
		return true
	}
	if strings.HasPrefix(path, "/api/v1/devices/") {
		id := strings.TrimPrefix(path, "/api/v1/devices/")
		return validDeviceID(id)
	}
	if strings.HasPrefix(path, "/api/v1/sessions/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/v1/sessions/"), "/")
		if len(parts) == 1 {
			return validSessionID(parts[0])
		}
		return len(parts) == 2 && validSessionID(parts[0]) && (parts[1] == "decision" || parts[1] == "signal" || parts[1] == "close")
	}
	return false
}

func handleRegister(broker *Broker, actor authenticatedDevice, body []byte, w http.ResponseWriter) {
	var input registerBody
	if fault := decodeJSON(body, &input); fault != nil {
		writeAPIError(w, fault)
		return
	}
	if input.ID != actor.ID {
		writeAPIError(w, newFault(http.StatusBadRequest, "invalid_registration", "Registration ID does not match the authenticated device."))
		return
	}
	device, fault := broker.registerDevice(input.ID, input.PublicKey, input.Name, input.Platform, input.AppVersion)
	if fault != nil {
		writeAPIError(w, fault)
		return
	}
	writeJSON(w, http.StatusOK, device)
}

func handleSessionRoute(broker *Broker, actor authenticatedDevice, request *http.Request, body []byte, w http.ResponseWriter) {
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, "/api/v1/sessions/"), "/")
	if len(parts) == 1 && request.Method == http.MethodGet {
		session, peer, fault := broker.getSession(parts[0], actor.ID)
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"session": session, "peer": peer})
		return
	}
	if len(parts) != 2 {
		writeAPIError(w, newFault(http.StatusNotFound, "not_found", "Endpoint was not found."))
		return
	}
	sessionID, action := parts[0], parts[1]
	switch action {
	case "decision":
		if request.Method != http.MethodPost {
			writeAPIError(w, newFault(http.StatusMethodNotAllowed, "method_not_allowed", "Use POST to approve or reject a session."))
			return
		}
		var input decisionBody
		if fault := decodeJSON(body, &input); fault != nil {
			writeAPIError(w, fault)
			return
		}
		session, fault := broker.decideSession(sessionID, actor.ID, input.Accepted, input.Permissions)
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		writeJSON(w, http.StatusOK, session)
	case "signal":
		if request.Method != http.MethodPost {
			writeAPIError(w, newFault(http.StatusMethodNotAllowed, "method_not_allowed", "Use POST to send a signaling message."))
			return
		}
		var input signalBody
		if fault := decodeJSON(body, &input); fault != nil {
			writeAPIError(w, fault)
			return
		}
		if fault := broker.forwardSignal(sessionID, actor.ID, input.Message); fault != nil {
			writeAPIError(w, fault)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true})
	case "close":
		if request.Method != http.MethodPost {
			writeAPIError(w, newFault(http.StatusMethodNotAllowed, "method_not_allowed", "Use POST to close a session."))
			return
		}
		var input closeBody
		if fault := decodeJSON(body, &input); fault != nil {
			writeAPIError(w, fault)
			return
		}
		session, fault := broker.closeSession(sessionID, actor.ID, input.Reason)
		if fault != nil {
			writeAPIError(w, fault)
			return
		}
		writeJSON(w, http.StatusOK, session)
	default:
		writeAPIError(w, newFault(http.StatusNotFound, "not_found", "Endpoint was not found."))
	}
}

func handleEvents(broker *Broker, actor authenticatedDevice, request *http.Request, w http.ResponseWriter) {
	cursor := uint64(0)
	if value := request.URL.Query().Get("after"); value != "" {
		parsed, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			writeAPIError(w, newFault(http.StatusBadRequest, "invalid_cursor", "Event cursor must be an unsigned integer."))
			return
		}
		cursor = parsed
	}
	wait := 0
	if value := request.URL.Query().Get("wait"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 || parsed > 25 {
			writeAPIError(w, newFault(http.StatusBadRequest, "invalid_wait", "Long-poll wait must be between zero and 25 seconds."))
			return
		}
		wait = parsed
	}
	batch, err := broker.pollEvents(request.Context(), actor.ID, cursor, time.Duration(wait)*time.Second)
	if err != nil {
		if err == context.Canceled || err == context.DeadlineExceeded {
			return
		}
		writeAPIError(w, newFault(http.StatusInternalServerError, "poll_failed", "Could not retrieve signaling events."))
		return
	}
	writeJSON(w, http.StatusOK, batch)
}

func decodeJSON(body []byte, destination any) *apiFault {
	if len(body) == 0 {
		return newFault(http.StatusBadRequest, "invalid_json", "A JSON request body is required.")
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return newFault(http.StatusBadRequest, "invalid_json", "Request JSON is invalid or contains unsupported fields.")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return newFault(http.StatusBadRequest, "invalid_json", "Request must contain exactly one JSON value.")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeAPIError(w http.ResponseWriter, fault *apiFault) {
	if fault == nil {
		fault = newFault(http.StatusInternalServerError, "internal_error", "An unexpected service error occurred.")
	}
	writeJSON(w, fault.Status, apiError{Error: errorBody{Code: fault.Code, Message: fault.Message}})
}

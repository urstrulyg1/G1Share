package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	address := strings.TrimSpace(os.Getenv("OPENDESK_SIGNALING_ADDR"))
	if address == "" {
		address = "127.0.0.1:8787"
	}
	if _, _, err := net.SplitHostPort(address); err != nil {
		log.Fatalf("invalid OPENDESK_SIGNALING_ADDR %q: %v", address, err)
	}

	broker, err := newBroker(dataDirectory(), turnSettingsFromEnvironment())
	if err != nil {
		log.Fatalf("could not initialize signaling registry: %v", err)
	}
	server := newServerWithBroker(address, broker)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go broker.cleanupLoop(ctx)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
	}()

	log.Printf("OpenDesk signaling v%s listening on %s", serviceVersion, address)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("signaling service failed: %v", err)
	}
}

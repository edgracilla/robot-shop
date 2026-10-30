// The product catalogue REST API: a port of ../catalogue/server.js to Go.
//
// The same routes, the same environment variables and the same answers — status codes, bodies
// and headers — so it can stand in for the Node service wherever that one runs. What is not
// carried over is the Instana collector and the random "datacenter" tag it put on each request.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))

// MongoDB. Set once the first connection is made, and — as in the Node service — not unset
// again: a query made while the database is away fails on its own, with the driver's error.
var (
	collection     *mongo.Collection
	mongoConnected atomic.Bool
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /products", withDB("database not avaiable", products))
	mux.HandleFunc("GET /product/{sku}", withDB("database not available", product))
	mux.HandleFunc("GET /products/{cat}", withDB("database not avaiable", productsInCategory))
	mux.HandleFunc("GET /categories", withDB("database not available", categories))
	mux.HandleFunc("GET /search/{text}", withDB("database not available", search))

	go mongoLoop()

	port := env("CATALOGUE_SERVER_PORT", "8080")
	logger.Info("Started on port", "port", port)
	if err := http.ListenAndServe(":"+port, middleware(mux)); err != nil {
		logger.Error("ERROR", "err", err)
		os.Exit(1)
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// Every response carries the two headers the storefront's browser timing needs, and every
// request is logged once it has been answered.
func middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		w.Header().Set("Timing-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		// Express matches a route with or without a slash on the end of it.
		if len(r.URL.Path) > 1 && strings.HasSuffix(r.URL.Path, "/") {
			r.URL.Path = strings.TrimRight(r.URL.Path, "/")
			r.URL.RawPath = ""
		}
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		logger.Info("request completed", "method", r.Method, "url", r.URL.RequestURI(), "status", recorder.status,
			"responseTime", time.Since(started).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// withDB answers 500 while the database has yet to be reached, in the words the route has
// always used — two of them misspelt, and kept that way for whoever matches on them.
func withDB(unavailable string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !mongoConnected.Load() {
			logger.Error("database not available")
			sendText(w, http.StatusInternalServerError, unavailable)
			return
		}
		handler(w, r)
	}
}

func health(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, ordered{{Key: "app", Value: "OK"}, {Key: "mongo", Value: mongoConnected.Load()}})
}

// all products
func products(w http.ResponseWriter, r *http.Request) {
	found, err := find(r.Context(), bson.D{}, nil)
	if err != nil {
		failed(w, err)
		return
	}
	sendJSON(w, found)
}

// product by SKU
func product(w http.ResponseWriter, r *http.Request) {
	// optionally slow this down
	if delay, err := strconv.Atoi(os.Getenv("GO_SLOW")); err == nil && delay > 0 {
		time.Sleep(time.Duration(delay) * time.Millisecond)
	}
	var found bson.D
	err := collection.FindOne(r.Context(), bson.D{{Key: "sku", Value: r.PathValue("sku")}}).Decode(&found)
	if errors.Is(err, mongo.ErrNoDocuments) {
		logger.Info("product", "product", nil)
		sendText(w, http.StatusNotFound, "SKU not found")
		return
	}
	if err != nil {
		failed(w, err)
		return
	}
	logger.Info("product", "sku", r.PathValue("sku"))
	sendJSON(w, ordered(found))
}

// products in a category
func productsInCategory(w http.ResponseWriter, r *http.Request) {
	found, err := find(r.Context(), bson.D{{Key: "categories", Value: r.PathValue("cat")}}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		failed(w, err)
		return
	}
	sendJSON(w, found)
}

// all categories
func categories(w http.ResponseWriter, r *http.Request) {
	found, err := collection.Distinct(r.Context(), "categories", bson.D{})
	if err != nil {
		failed(w, err)
		return
	}
	if found == nil {
		found = []any{}
	}
	sendJSON(w, found)
}

// search name and description
func search(w http.ResponseWriter, r *http.Request) {
	found, err := find(r.Context(), bson.D{{Key: "$text", Value: bson.D{{Key: "$search", Value: r.PathValue("text")}}}}, nil)
	if err != nil {
		failed(w, err)
		return
	}
	sendJSON(w, found)
}

// find returns the matching products, as an empty list rather than nothing when there are none.
func find(ctx context.Context, filter bson.D, opts *options.FindOptions) ([]ordered, error) {
	args := []*options.FindOptions{}
	if opts != nil {
		args = append(args, opts)
	}
	cursor, err := collection.Find(ctx, filter, args...)
	if err != nil {
		return nil, err
	}
	var documents []bson.D
	if err := cursor.All(ctx, &documents); err != nil {
		return nil, err
	}
	found := make([]ordered, 0, len(documents))
	for _, document := range documents {
		found = append(found, ordered(document))
	}
	return found, nil
}

func failed(w http.ResponseWriter, err error) {
	logger.Error("ERROR", "err", err)
	sendText(w, http.StatusInternalServerError, err.Error())
}

// ordered is a document written out as JSON with its fields in the order the database holds
// them — which is what the Node service sends, and what a map would lose.
type ordered bson.D

func (document ordered) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for i, field := range document {
		if i > 0 {
			out.WriteByte(',')
		}
		key, err := marshal(field.Key)
		if err != nil {
			return nil, err
		}
		out.Write(key)
		out.WriteByte(':')
		value, err := marshal(nested(field.Value))
		if err != nil {
			return nil, err
		}
		out.Write(value)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// nested keeps the same order for documents inside documents, and inside lists.
func nested(value any) any {
	switch typed := value.(type) {
	case bson.D:
		return ordered(typed)
	case bson.A:
		items := make([]any, len(typed))
		for i, item := range typed {
			items[i] = nested(item)
		}
		return items
	default:
		return value
	}
}

// marshal is json.Marshal without its escaping of <, > and &, which JSON.stringify leaves alone.
func marshal(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(out.Bytes(), "\n"), nil
}

func sendJSON(w http.ResponseWriter, value any) {
	body, err := marshal(value)
	if err != nil {
		failed(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(body)
}

func sendText(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	w.Write([]byte(text))
}

// set up Mongo
func mongoConnect() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := mongo.Connect(ctx, options.Client().ApplyURI(env("MONGO_URL", "mongodb://mongodb:27017/catalogue")))
	if err != nil {
		return err
	}
	// The driver connects when it is first used; asked now, so "connected" means it.
	if err := client.Ping(ctx, nil); err != nil {
		client.Disconnect(context.Background())
		return err
	}
	collection = client.Database("catalogue").Collection("products")
	return nil
}

// mongodb connection retry loop
func mongoLoop() {
	for {
		err := mongoConnect()
		if err == nil {
			mongoConnected.Store(true)
			logger.Info("MongoDB connected")
			return
		}
		logger.Error("ERROR", "err", err)
		time.Sleep(2 * time.Second)
	}
}

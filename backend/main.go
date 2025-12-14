package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"gopkg.in/yaml.v2"
)

var (
	appConfig  *AppConfig
	configPath = "config.yaml"
	configMu   sync.Mutex
)

// in-memory cache for prefix stats (size and last-modified)
type PrefixStats struct {
	Size         int64     `json:"size"`
	LastModified time.Time `json:"lastModified"`
	Ready        bool      `json:"ready"`
	Error        string    `json:"error,omitempty"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

var (
	prefixStatsMu sync.Mutex
	prefixStats   = map[string]PrefixStats{}
)

func prefixStatsKey(region, bucket, prefix string) string {
	return region + "|" + bucket + "|" + prefix
}

type spaHandler struct {
	staticPath string
	indexPath  string
}

// --- region helpers and management handlers ---

func findRegionByName(name string) *RegionConfig {
	if name == "" && len(appConfig.Regions) > 0 {
		return &appConfig.Regions[0]
	}
	for i := range appConfig.Regions {
		if appConfig.Regions[i].Name == name {
			return &appConfig.Regions[i]
		}
	}
	return nil
}

func getS3ClientForRequest(regionName string) (*s3.Client, *RegionConfig, error) {
	cfg := findRegionByName(regionName)
	if cfg == nil {
		return nil, nil, fmt.Errorf("region not found: %s", regionName)
	}
	// Build AWS SDK config per region. Use a signing region that can be overridden
	// per-region (useful for S3-compatible endpoints like MinIO/Ceph which often
	// expect a signing region such as "us-east-1"). If SigningRegion is not set
	// and an Endpoint is configured, default to "us-east-1".
	signingRegion := cfg.SigningRegion
	if signingRegion == "" {
		if cfg.Endpoint != "" {
			signingRegion = "us-east-1"
		} else {
			signingRegion = cfg.Region
		}
	}

	awsCfg, err := awscfg.LoadDefaultConfig(context.TODO(),
		awscfg.WithRegion(signingRegion),
		awscfg.WithCredentialsProvider(aws.CredentialsProviderFunc(func(ctx context.Context) (aws.Credentials, error) {
			return aws.Credentials{
				AccessKeyID:     cfg.AccessKey,
				SecretAccessKey: cfg.SecretKey,
			}, nil
		})),
		awscfg.WithEndpointResolverWithOptions(aws.EndpointResolverWithOptionsFunc(
			func(service, region string, options ...interface{}) (aws.Endpoint, error) {
				if cfg.Endpoint != "" {
					return aws.Endpoint{
						URL:               cfg.Endpoint,
						Source:            aws.EndpointSourceCustom,
						SigningRegion:     signingRegion,
						HostnameImmutable: true,
					}, nil
				}
				return aws.Endpoint{}, &aws.EndpointNotFoundError{}
			})),
	)
	if err != nil {
		return nil, nil, err
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) { o.UsePathStyle = true })
	return client, cfg, nil
}

func listRegions(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(appConfig.Regions)
}

func createRegion(w http.ResponseWriter, r *http.Request) {
	var rc RegionConfig
	if err := json.NewDecoder(r.Body).Decode(&rc); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if rc.Name == "" || rc.AccessKey == "" || rc.SecretKey == "" {
		http.Error(w, "name, access_key and secret_key are required", http.StatusBadRequest)
		return
	}

	configMu.Lock()
	defer configMu.Unlock()

	// check duplicate
	for _, existing := range appConfig.Regions {
		if existing.Name == rc.Name {
			http.Error(w, "region with this name already exists", http.StatusBadRequest)
			return
		}
	}
	appConfig.Regions = append(appConfig.Regions, rc)

	// persist
	buf, err := yaml.Marshal(appConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to write config: %v", err), http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(configPath, buf, 0644); err != nil {
		http.Error(w, fmt.Sprintf("failed to persist config: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func deleteRegion(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["regionName"]

	configMu.Lock()
	defer configMu.Unlock()

	found := -1
	for i, existing := range appConfig.Regions {
		if existing.Name == name {
			found = i
			break
		}
	}
	if found == -1 {
		http.Error(w, "region not found", http.StatusNotFound)
		return
	}
	appConfig.Regions = append(appConfig.Regions[:found], appConfig.Regions[found+1:]...)

	buf, err := yaml.Marshal(appConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to write config: %v", err), http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(configPath, buf, 0644); err != nil {
		http.Error(w, fmt.Sprintf("failed to persist config: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// get the absolute path to prevent directory traversal
	path, err := filepath.Abs(r.URL.Path)
	if err != nil {
		// if we failed to get the absolute path respond with a 400 bad request
		// and stop
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// prepend the path with the path to the static directory
	path = filepath.Join(h.staticPath, path)

	// check whether a file exists at the given path
	_, err = os.Stat(path)
	if os.IsNotExist(err) {
		// file does not exist, serve index.html
		http.ServeFile(w, r, filepath.Join(h.staticPath, h.indexPath))
		return
	} else if err != nil {
		// if we got an error (that wasn't that the file doesn't exist) stating the
		// file, return a 500 internal server error and stop
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// otherwise, use http.FileServer to serve the static file
	http.FileServer(http.Dir(h.staticPath)).ServeHTTP(w, r)
}

func main() {
	var err error
	appConfig, err = NewConfig("config.yaml")
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}
	// note: per-request clients are created using region configs

	r := mux.NewRouter()

	api := r.PathPrefix("/api").Subrouter()

	api.HandleFunc("/buckets", listBuckets).Methods("GET")
	api.HandleFunc("/buckets", createBucket).Methods("POST")
	api.HandleFunc("/buckets/{bucketName}", deleteBucket).Methods("DELETE")
	api.HandleFunc("/buckets/{bucketName}/objects", listObjects).Methods("GET")
	api.HandleFunc("/buckets/{bucketName}/objects/{objectKey:.+}", downloadObject).Methods("GET")
	api.HandleFunc("/buckets/{bucketName}/objects", uploadObject).Methods("POST")
	api.HandleFunc("/buckets/{bucketName}/objects/{objectKey:.+}", deleteObject).Methods("DELETE")
	api.HandleFunc("/buckets/{bucketName}/folders/{folderPrefix:.+}", deleteFolder).Methods("DELETE")
	api.HandleFunc("/buckets/{bucketName}/folders/{folderPrefix:.+}", downloadFolder).Methods("GET").Queries("download", "true")

	// region management
	api.HandleFunc("/regions", listRegions).Methods("GET")
	api.HandleFunc("/regions", createRegion).Methods("POST")
	api.HandleFunc("/regions/{regionName}", deleteRegion).Methods("DELETE")

	// prefix stats (background computed)
	api.HandleFunc("/prefix-stats", prefixStatsHandler).Methods("GET")

	// CORS middleware
	cOrigins := handlers.AllowedOrigins([]string{"*"})
	cHeaders := handlers.AllowedHeaders([]string{"X-Requested-With", "Content-Type", "Authorization"})
	cMethods := handlers.AllowedMethods([]string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"})

	log.Println("Starting server on :8081")
	if err := http.ListenAndServe(":8081", handlers.CORS(cOrigins, cHeaders, cMethods)(r)); err != nil {
		log.Fatal(err)
	}
}

func createBucket(w http.ResponseWriter, r *http.Request) {
	var data map[string]string
	if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	bucketName, ok := data["bucketName"]
	if !ok || bucketName == "" {
		http.Error(w, "Bucket name is required", http.StatusBadRequest)
		return
	}

	// determine region to use
	regionName := r.URL.Query().Get("region")
	client, regionCfg, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	// Some S3-compatible endpoints (or certain AWS regions like us-east-1)
	// do not accept an explicit LocationConstraint. If a custom endpoint
	// is configured (cfg.Endpoint != "") or the region is the legacy
	// "us-east-1", omit CreateBucketConfiguration to avoid InvalidLocationConstraint.
	var cbInput s3.CreateBucketInput
	cbInput.Bucket = aws.String(bucketName)
	if regionCfg.Endpoint == "" && regionCfg.Region != "" && regionCfg.Region != "us-east-1" {
		cbInput.CreateBucketConfiguration = &types.CreateBucketConfiguration{
			LocationConstraint: types.BucketLocationConstraint(regionCfg.Region),
		}
	}
	_, err = client.CreateBucket(context.TODO(), &cbInput)

	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create bucket: %s", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func listBuckets(w http.ResponseWriter, r *http.Request) {
	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	result, err := client.ListBuckets(context.TODO(), &s3.ListBucketsInput{})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list buckets: %s", err), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(result.Buckets)
}

func listObjects(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]
	prefix := r.URL.Query().Get("prefix")

	// Ensure the prefix, if not empty, ends with a slash
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	input := &s3.ListObjectsV2Input{
		Bucket:    aws.String(bucketName),
		Prefix:    aws.String(prefix),
		Delimiter: aws.String("/"),
	}

	result, err := client.ListObjectsV2(context.TODO(), input)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list objects: %s", err), http.StatusInternalServerError)
		return
	}

	// Build a structured response where folder entries include aggregated size and last modified
	var items []map[string]interface{}

	// files
	for _, obj := range result.Contents {
		// Do not include the folder marker itself
		if *obj.Key == prefix {
			continue
		}
		lm := ""
		if obj.LastModified != nil {
			lm = obj.LastModified.Format(time.RFC3339)
		}
		items = append(items, map[string]interface{}{
			"Key":          *obj.Key,
			"Size":         obj.Size,
			"LastModified": lm,
			"IsFolder":     false,
		})
	}

	// folders (common prefixes) — schedule aggregated stats in background and return immediately
	for _, p := range result.CommonPrefixes {
		pref := *p.Prefix

		// check cache for ready stats
		key := prefixStatsKey(regionName, bucketName, pref)
		prefixStatsMu.Lock()
		ps, ok := prefixStats[key]
		prefixStatsMu.Unlock()

		if ok && ps.Ready {
			lm := ""
			if !ps.LastModified.IsZero() {
				lm = ps.LastModified.Format(time.RFC3339)
			}
			items = append(items, map[string]interface{}{
				"Key":          pref,
				"Size":         ps.Size,
				"LastModified": lm,
				"IsFolder":     true,
			})
			continue
		}

		// not ready — return folder entry immediately without stats
		items = append(items, map[string]interface{}{"Key": pref, "IsFolder": true})

		// schedule background computation if not already present
		if !ok {
			// mark as pending so we don't schedule duplicates
			prefixStatsMu.Lock()
			prefixStats[key] = PrefixStats{Ready: false, UpdatedAt: time.Now()}
			prefixStatsMu.Unlock()

			go func(region, bucket, prefix string) {
				// create a client for the same region
				clientBg, _, err := getS3ClientForRequest(region)
				if err != nil {
					prefixStatsMu.Lock()
					prefixStats[key] = PrefixStats{Ready: false, Error: err.Error(), UpdatedAt: time.Now()}
					prefixStatsMu.Unlock()
					return
				}
				totalSize, lastModified, err := computePrefixStats(clientBg, bucket, prefix)
				prefixStatsMu.Lock()
				if err != nil {
					prefixStats[key] = PrefixStats{Ready: false, Error: err.Error(), UpdatedAt: time.Now()}
				} else {
					prefixStats[key] = PrefixStats{Size: totalSize, LastModified: lastModified, Ready: true, UpdatedAt: time.Now()}
				}
				prefixStatsMu.Unlock()
			}(regionName, bucketName, pref)
		}
	}

	json.NewEncoder(w).Encode(items)
}

// computePrefixStats iterates over all objects under the prefix and returns
// the total size (sum of sizes) and the latest LastModified timestamp.
func computePrefixStats(client *s3.Client, bucket, prefix string) (int64, time.Time, error) {
	var continuation *string
	var total int64
	var latest time.Time

	for {
		input := &s3.ListObjectsV2Input{
			Bucket:            aws.String(bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: continuation,
		}
		out, err := client.ListObjectsV2(context.TODO(), input)
		if err != nil {
			return 0, time.Time{}, err
		}
		for _, o := range out.Contents {
			// In AWS SDK v2, Size is *int64 on some builds; guard against nil
			if o.Size != nil {
				total += *o.Size
			}
			if o.LastModified != nil && o.LastModified.After(latest) {
				latest = *o.LastModified
			}
		}
		// IsTruncated may be a *bool; check safely
		if out.IsTruncated == nil || !*out.IsTruncated {
			break
		}
		continuation = out.NextContinuationToken
	}

	return total, latest, nil
}

// prefixStatsHandler returns cached prefix stats or a not-ready indicator.
// Query params: region, bucket, prefix
func prefixStatsHandler(w http.ResponseWriter, r *http.Request) {
	bucket := r.URL.Query().Get("bucket")
	prefix := r.URL.Query().Get("prefix")
	region := r.URL.Query().Get("region")

	if bucket == "" || prefix == "" {
		http.Error(w, "bucket and prefix query params are required", http.StatusBadRequest)
		return
	}

	key := prefixStatsKey(region, bucket, prefix)
	prefixStatsMu.Lock()
	ps, ok := prefixStats[key]
	prefixStatsMu.Unlock()

	if !ok {
		// not scheduled yet
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"ready": false})
		return
	}

	// return available data
	resp := map[string]interface{}{
		"ready":     ps.Ready,
		"size":      ps.Size,
		"updatedAt": ps.UpdatedAt.Format(time.RFC3339),
	}
	if !ps.LastModified.IsZero() {
		resp["lastModified"] = ps.LastModified.Format(time.RFC3339)
	}
	if ps.Error != "" {
		resp["error"] = ps.Error
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func uploadObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]

	r.ParseMultipartForm(10 << 20) // 10 MB

	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Failed to get file from form", http.StatusBadRequest)
		return
	}
	defer file.Close()

	key := handler.Filename
	prefix := r.FormValue("prefix")

	if prefix != "" {
		key = path.Join(prefix, key)
	}

	key = path.Clean(key)

	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	// Some S3-compatible servers (Ceph RGW, older MinIO) do not accept
	// AWS v4 chunked uploads. To maximize compatibility, buffer the upload
	// to a temporary file and send with an explicit ContentLength using a
	// ReadSeeker. This also avoids signature/payload mismatches.
	tmp, err := os.CreateTemp("", "s3upload-*")
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create temp file: %v", err), http.StatusInternalServerError)
		return
	}
	tmpName := tmp.Name()
	// ensure cleanup
	defer func() {
		tmp.Close()
		os.Remove(tmpName)
	}()

	// copy the uploaded content into temp file
	if _, err := file.Seek(0, io.SeekStart); err == nil {
		// if original supports seeking, ensure at start
	}
	if _, err := io.Copy(tmp, file); err != nil {
		http.Error(w, fmt.Sprintf("Failed to buffer upload: %v", err), http.StatusInternalServerError)
		return
	}

	// rewind temp for upload
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		http.Error(w, fmt.Sprintf("Failed to seek temp upload file: %v", err), http.StatusInternalServerError)
		return
	}
	fi, err := tmp.Stat()
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to stat temp upload file: %v", err), http.StatusInternalServerError)
		return
	}
	contentLen := fi.Size()

	_, err = client.PutObject(context.TODO(), &s3.PutObjectInput{
		Bucket:        aws.String(bucketName),
		Key:           aws.String(key),
		Body:          tmp,
		ContentLength: aws.Int64(contentLen),
	})
	if err != nil {
		// return the error to the client without logging to keep output clean
		http.Error(w, fmt.Sprintf("Failed to upload file: %s", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func downloadObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]
	objectKey := vars["objectKey"]

	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	result, err := client.GetObject(context.TODO(), &s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to download file: %s", err), http.StatusInternalServerError)
		return
	}
	defer result.Body.Close()

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", objectKey))
	w.Header().Set("Content-Type", "application/octet-stream")
	io.Copy(w, result.Body)
}

func deleteObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]
	objectKey := vars["objectKey"]

	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	_, err = client.DeleteObject(context.TODO(), &s3.DeleteObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to delete file: %s", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func deleteFolder(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]
	folderPrefix := vars["folderPrefix"]

	// List all objects from the folder
	listObjectsInput := &s3.ListObjectsV2Input{
		Bucket: aws.String(bucketName),
		Prefix: aws.String(folderPrefix),
	}
	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	listedObjects, err := client.ListObjectsV2(context.TODO(), listObjectsInput)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list objects for deletion: %s", err), http.StatusInternalServerError)
		return
	}

	// Create a slice of objects to delete
	if len(listedObjects.Contents) > 0 {
		var objectsToDelete []types.ObjectIdentifier
		for _, obj := range listedObjects.Contents {
			objectsToDelete = append(objectsToDelete, types.ObjectIdentifier{Key: obj.Key})
		}

		// Delete the objects
		deleteObjectsInput := &s3.DeleteObjectsInput{
			Bucket: aws.String(bucketName),
			Delete: &types.Delete{Objects: objectsToDelete},
		}
		_, err = client.DeleteObjects(context.TODO(), deleteObjectsInput)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to delete objects: %s", err), http.StatusInternalServerError)
			return
		}
	}

	w.WriteHeader(http.StatusOK)
}

func downloadFolder(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]
	folderPrefix := vars["folderPrefix"]

	// Create a new zip archive.
	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	// List all objects from the folder
	listObjectsInput := &s3.ListObjectsV2Input{
		Bucket: aws.String(bucketName),
		Prefix: aws.String(folderPrefix),
	}
	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	listedObjects, err := client.ListObjectsV2(context.TODO(), listObjectsInput)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list objects for download: %s", err), http.StatusInternalServerError)
		return
	}

	fileName := path.Clean(folderPrefix)

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.zip\"", fileName))

	// Add each object to the zip archive
	for _, object := range listedObjects.Contents {
		// Get the object from S3
		getObjectInput := &s3.GetObjectInput{
			Bucket: aws.String(bucketName),
			Key:    object.Key,
		}
		getObjectOutput, err := client.GetObject(context.TODO(), getObjectInput)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to get object %s: %s", *object.Key, err), http.StatusInternalServerError)
			return
		}
		defer getObjectOutput.Body.Close()

		// Create a new file in the zip archive
		zipFile, err := zipWriter.Create(*object.Key)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to create zip file for %s: %s", *object.Key, err), http.StatusInternalServerError)
			return
		}

		// Copy the object content to the zip file
		_, err = io.Copy(zipFile, getObjectOutput.Body)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to copy object %s to zip: %s", *object.Key, err), http.StatusInternalServerError)
			return
		}
	}
}

func deleteBucket(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]

	// List all objects from the bucket
	listObjectsInput := &s3.ListObjectsV2Input{
		Bucket: aws.String(bucketName),
	}
	regionName := r.URL.Query().Get("region")
	client, _, err := getS3ClientForRequest(regionName)
	if err != nil {
		http.Error(w, fmt.Sprintf("Region config error: %v", err), http.StatusBadRequest)
		return
	}

	listedObjects, err := client.ListObjectsV2(context.TODO(), listObjectsInput)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list objects for deletion: %s", err), http.StatusInternalServerError)
		return
	}

	// Create a slice of objects to delete
	if len(listedObjects.Contents) > 0 {
		var objectsToDelete []types.ObjectIdentifier
		for _, obj := range listedObjects.Contents {
			objectsToDelete = append(objectsToDelete, types.ObjectIdentifier{Key: obj.Key})
		}

		// Delete the objects
		deleteObjectsInput := &s3.DeleteObjectsInput{
			Bucket: aws.String(bucketName),
			Delete: &types.Delete{Objects: objectsToDelete},
		}
		_, err = client.DeleteObjects(context.TODO(), deleteObjectsInput)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to delete objects: %s", err), http.StatusInternalServerError)
			return
		}
	}

	// Delete the bucket
	_, err = client.DeleteBucket(context.TODO(), &s3.DeleteBucketInput{
		Bucket: aws.String(bucketName),
	})

	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to delete bucket: %s", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

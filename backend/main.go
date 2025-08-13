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

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
)

var s3Client *s3.Client
var awsRegion string

type spaHandler struct {
	staticPath string
	indexPath  string
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
	appConfig, err := NewConfig("config.yaml")
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	awsRegion = appConfig.AWS.Region

	cfg, err := config.LoadDefaultConfig(context.TODO(),
		config.WithRegion(awsRegion),
		config.WithCredentialsProvider(aws.CredentialsProviderFunc(func(ctx context.Context) (aws.Credentials, error) {
			return aws.Credentials{
				AccessKeyID:     appConfig.AWS.AccessKey,
				SecretAccessKey: appConfig.AWS.SecretKey,
			}, nil
		})),
		config.WithEndpointResolverWithOptions(aws.EndpointResolverWithOptionsFunc(
			func(service, region string, options ...interface{}) (aws.Endpoint, error) {
				if appConfig.AWS.Endpoint != "" {
					return aws.Endpoint{
						URL:               appConfig.AWS.Endpoint,
						Source:            aws.EndpointSourceCustom,
						SigningRegion:     awsRegion,
						HostnameImmutable: true,
					}, nil
				}
				return aws.Endpoint{}, &aws.EndpointNotFoundError{}
			})),
	)
	if err != nil {
		log.Fatalf("unable to load SDK config, %v", err)
	}

	s3Client = s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true
	})

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

	_, err := s3Client.CreateBucket(context.TODO(), &s3.CreateBucketInput{
		Bucket: aws.String(bucketName),
		CreateBucketConfiguration: &types.CreateBucketConfiguration{
			LocationConstraint: types.BucketLocationConstraint(awsRegion),
		},
	})

	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create bucket: %s", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func listBuckets(w http.ResponseWriter, r *http.Request) {
	result, err := s3Client.ListBuckets(context.TODO(), &s3.ListBucketsInput{})
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

	input := &s3.ListObjectsV2Input{
		Bucket:    aws.String(bucketName),
		Prefix:    aws.String(prefix),
		Delimiter: aws.String("/"),
	}

	result, err := s3Client.ListObjectsV2(context.TODO(), input)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list objects: %s", err), http.StatusInternalServerError)
		return
	}

	var objects []interface{}
	for _, obj := range result.Contents {
		// Do not include the folder itself in the list of objects
		if *obj.Key == prefix {
			continue
		}
		objects = append(objects, obj)
	}
	for _, p := range result.CommonPrefixes {
		objects = append(objects, map[string]interface{}{"Key": *p.Prefix})
	}

	json.NewEncoder(w).Encode(objects)
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

	_, err = s3Client.PutObject(context.TODO(), &s3.PutObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(key),
		Body:   file,
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to upload file: %s", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func downloadObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucketName := vars["bucketName"]
	objectKey := vars["objectKey"]

	result, err := s3Client.GetObject(context.TODO(), &s3.GetObjectInput{
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

	_, err := s3Client.DeleteObject(context.TODO(), &s3.DeleteObjectInput{
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
	listedObjects, err := s3Client.ListObjectsV2(context.TODO(), listObjectsInput)
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
		_, err = s3Client.DeleteObjects(context.TODO(), deleteObjectsInput)
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
	listedObjects, err := s3Client.ListObjectsV2(context.TODO(), listObjectsInput)
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
		getObjectOutput, err := s3Client.GetObject(context.TODO(), getObjectInput)
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
	listedObjects, err := s3Client.ListObjectsV2(context.TODO(), listObjectsInput)
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
		_, err = s3Client.DeleteObjects(context.TODO(), deleteObjectsInput)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to delete objects: %s", err), http.StatusInternalServerError)
			return
		}
	}

	// Delete the bucket
	_, err = s3Client.DeleteBucket(context.TODO(), &s3.DeleteBucketInput{
		Bucket: aws.String(bucketName),
	})

	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to delete bucket: %s", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

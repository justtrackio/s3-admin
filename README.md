# S3 Admin

A simple web-based UI for managing S3-compatible object storage.

This project provides a user-friendly interface to perform common operations on S3 buckets and objects, such as creating, deleting, uploading, and downloading.

## Features

*   List, create, and delete buckets.
*   Browse objects with folder-like navigation.
*   Upload and download objects.
*   Delete objects and folders.
*   Download entire folders as a ZIP archive.
*   Modern, responsive UI built with Material-UI.

## Tech Stack

*   **Frontend:** React, TypeScript, Vite, Material-UI
*   **Backend:** Go, Gorilla Mux, AWS SDK for Go V2

## Prerequisites

*   Go (version 1.21 or later)
*   Node.js (with `bun` package manager)
*   AWS credentials with S3 access

## Setup and Running the Application

### Backend

1.  **Navigate to the backend directory:**
    ```bash
    cd backend
    ```

2.  **Configure your S3 credentials:**
    Rename `config.yaml.example` to `config.yaml` and fill in your S3 provider's details.

    ```yaml
    aws:
      region: "us-east-1"
      access_key: "YOUR_ACCESS_KEY"
      secret_key: "YOUR_SECRET_KEY"
      endpoint: "http://localhost:9000" # Optional: for MinIO or other S3-compatible storage
    ```

3.  **Install dependencies and run the backend server:**
    ```bash
    go mod tidy
    go run main.go
    ```

    The backend server will be running on `http://localhost:8081`.

### Frontend

1.  **Navigate to the frontend directory:**
    ```bash
    cd frontend
    ```

2.  **Install dependencies:**
    ```bash
    bun install
    ```

3.  **Run the frontend development server:**
    ```bash
    bun dev
    ```

    The frontend will be available at `http://localhost:5173` and will connect to the backend API.

## Building for Production

This project is set up to be easily built and deployed using Docker.

1.  **Build the Docker image:**
    ```bash
    ./build-and-push.sh your-docker-repo/s3-admin
    ```

2.  **Run the Docker container:**
    ```bash
    docker run -p 8080:8080 -v /path/to/your/config.yaml:/app/config.yaml your-docker-repo/s3-admin
    ```

    The application will be accessible at `http://localhost:8080`.

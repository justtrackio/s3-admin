package main

import (
	"os"

	"gopkg.in/yaml.v2"
)

type AppConfig struct {
	AWS struct {
		Region    string `yaml:"region"`
		AccessKey string `yaml:"access_key"`
		SecretKey string `yaml:"secret_key"`
		Endpoint  string `yaml:"endpoint,omitempty"`
	} `yaml:"aws"`
}

func NewConfig(path string) (*AppConfig, error) {
	appConfig := &AppConfig{}

	configFile, err := os.ReadFile(path)
	if err == nil {
		if err := yaml.Unmarshal(configFile, appConfig); err != nil {
			return nil, err
		}
	}

	if os.Getenv("AWS_REGION") != "" {
		appConfig.AWS.Region = os.Getenv("AWS_REGION")
	}
	if os.Getenv("AWS_ACCESS_KEY_ID") != "" {
		appConfig.AWS.AccessKey = os.Getenv("AWS_ACCESS_KEY_ID")
	}
	if os.Getenv("AWS_SECRET_ACCESS_KEY") != "" {
		appConfig.AWS.SecretKey = os.Getenv("AWS_SECRET_ACCESS_KEY")
	}
	if os.Getenv("AWS_ENDPOINT") != "" {
		appConfig.AWS.Endpoint = os.Getenv("AWS_ENDPOINT")
	}

	return appConfig, nil
}

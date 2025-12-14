package main

import (
	"os"

	"gopkg.in/yaml.v2"
)

type RegionConfig struct {
	Name   string `yaml:"name" json:"name"`
	Region string `yaml:"region" json:"region"`
	// optional signing region to use when computing request signatures
	SigningRegion string `yaml:"signing_region,omitempty" json:"signing_region,omitempty"`
	AccessKey     string `yaml:"access_key" json:"access_key"`
	SecretKey     string `yaml:"secret_key" json:"secret_key"`
	Endpoint      string `yaml:"endpoint,omitempty" json:"endpoint,omitempty"`
}

type AppConfig struct {
	// legacy single AWS config (kept for backwards compatibility)
	AWS struct {
		Region    string `yaml:"region" json:"region"`
		AccessKey string `yaml:"access_key" json:"access_key"`
		SecretKey string `yaml:"secret_key" json:"secret_key"`
		Endpoint  string `yaml:"endpoint,omitempty" json:"endpoint,omitempty"`
	} `yaml:"aws" json:"aws"`

	// new multi-region configuration
	Regions []RegionConfig `yaml:"regions,omitempty" json:"regions,omitempty"`
}

func NewConfig(path string) (*AppConfig, error) {
	appConfig := &AppConfig{}

	configFile, err := os.ReadFile(path)
	if err == nil {
		if err := yaml.Unmarshal(configFile, appConfig); err != nil {
			return nil, err
		}
	}

	// Environment overrides for legacy single AWS block
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

	// If no Regions are defined but legacy AWS is present, create a default region entry
	if len(appConfig.Regions) == 0 && (appConfig.AWS.Region != "" || appConfig.AWS.AccessKey != "" || appConfig.AWS.SecretKey != "") {
		defaultName := appConfig.AWS.Region
		if defaultName == "" {
			defaultName = "default"
		}
		appConfig.Regions = []RegionConfig{{
			Name:          defaultName,
			Region:        appConfig.AWS.Region,
			SigningRegion: appConfig.AWS.Region,
			AccessKey:     appConfig.AWS.AccessKey,
			SecretKey:     appConfig.AWS.SecretKey,
			Endpoint:      appConfig.AWS.Endpoint,
		}}
	}

	return appConfig, nil
}

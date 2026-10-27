module github.com/medilens-ai/medilens

go 1.27

// npm installs third-party Go sources under node_modules (e.g. flatted);
// they are not part of this module.
ignore node_modules

require (
	github.com/modelcontextprotocol/go-sdk v1.8.0
	golang.org/x/image v0.47.0
	golang.org/x/text v0.43.0
	golang.org/x/time v0.16.0
)

require (
	github.com/google/jsonschema-go v0.4.3 // indirect
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	golang.org/x/oauth2 v0.35.0 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
)

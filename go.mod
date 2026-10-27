module github.com/medilens-ai/medilens

go 1.27

// npm installs third-party Go sources under node_modules (e.g. flatted);
// they are not part of this module.
ignore node_modules

require (
	golang.org/x/image v0.47.0
	golang.org/x/text v0.43.0
)

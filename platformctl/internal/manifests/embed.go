package manifests

import "embed"

//go:embed data/*.yaml
var FS embed.FS

func Read(name string) ([]byte, error) {
	return FS.ReadFile("data/" + name)
}

func List() ([]string, error) {
	entries, err := FS.ReadDir("data")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names, nil
}

package main

import "github.com/Mpratyush54/SERVER-automation/platformctl/cmd"

var version = "dev"

func main() {
	cmd.Version = version
	cmd.Execute()
}

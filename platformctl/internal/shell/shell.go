package shell

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func Run(cmd string, args ...string) error {
	c := exec.Command(cmd, args...)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Stdin = os.Stdin
	return c.Run()
}

func RunSilent(cmd string, args ...string) error {
	c := exec.Command(cmd, args...)
	return c.Run()
}

func Output(cmd string, args ...string) (string, error) {
	c := exec.Command(cmd, args...)
	var out bytes.Buffer
	c.Stdout = &out
	c.Stderr = &out
	err := c.Run()
	return strings.TrimSpace(out.String()), err
}

func Pipe(cmd string, args ...string) (*exec.Cmd, error) {
	c := exec.Command(cmd, args...)
	c.Stderr = os.Stderr
	return c, nil
}

func Exists(cmd string) bool {
	_, err := exec.LookPath(cmd)
	return err == nil
}

func RunBash(script string) error {
	c := exec.Command("bash", "-c", script)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Stdin = os.Stdin
	return c.Run()
}

func OutputBash(script string) (string, error) {
	c := exec.Command("bash", "-c", script)
	var out bytes.Buffer
	c.Stdout = &out
	c.Stderr = &out
	err := c.Run()
	return strings.TrimSpace(out.String()), err
}

func WriteFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0644)
}

func AppendFile(path, content string) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(content)
	return err
}

func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func MkdirAll(path string) error {
	return os.MkdirAll(path, 0755)
}

func RunWithInput(cmd string, args []string, input string) (string, error) {
	c := exec.Command(cmd, args...)
	c.Stdin = strings.NewReader(input)
	var out bytes.Buffer
	c.Stdout = &out
	c.Stderr = &out
	err := c.Run()
	return strings.TrimSpace(out.String()), err
}

func HasSudo() bool {
	err := RunSilent("sudo", "-n", "true")
	return err == nil
}

func Sudo(cmd string, args ...string) error {
	sudoArgs := append([]string{cmd}, args...)
	return Run("sudo", sudoArgs...)
}

func SudoOutput(cmd string, args ...string) (string, error) {
	sudoArgs := append([]string{cmd}, args...)
	return Output("sudo", sudoArgs...)
}

func SudoWriteFile(path, content string) error {
	tmpPath := fmt.Sprintf("/tmp/platformctl_%s", strings.ReplaceAll(path, "/", "_"))
	if err := WriteFile(tmpPath, content); err != nil {
		return err
	}
	defer os.Remove(tmpPath)
	return Sudo("cp", tmpPath, path)
}

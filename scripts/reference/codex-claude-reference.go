// Copy this harness into a temporary, pinned CLIProxyAPI checkout before use.
// It invokes the original Go implementation; HappyClaw does not depend on Go.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	claude "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/codex/claude"
)

type fixture struct {
	Name             string            `json:"name"`
	Request          json.RawMessage   `json:"request"`
	Events           []json.RawMessage `json:"events,omitempty"`
	ExpectedRequest  json.RawMessage   `json:"expectedRequest,omitempty"`
	ExpectedResponse json.RawMessage   `json:"expectedResponse,omitempty"`
	ExpectedStream   []string          `json:"expectedStream,omitempty"`
}

type corpus struct {
	Repository string    `json:"repository"`
	Commit     string    `json:"commit"`
	Fixtures   []fixture `json:"fixtures"`
}

func main() {
	var input corpus
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		panic(err)
	}
	for i := range input.Fixtures {
		f := &input.Fixtures[i]
		f.ExpectedStream = nil
		f.ExpectedResponse = nil
		f.ExpectedRequest = claude.ConvertClaudeRequestToCodex("gpt-6-sol", f.Request, true)
		f.ExpectedRequest = helps.NormalizeCodexToolSchemas(f.ExpectedRequest)
		var param any
		for _, event := range f.Events {
			for _, chunk := range claude.ConvertCodexResponseToClaude(context.Background(), "gpt-6-sol", f.Request, f.ExpectedRequest, append([]byte("data: "), event...), &param) {
				f.ExpectedStream = append(f.ExpectedStream, string(chunk))
			}
			if result := claude.ConvertCodexResponseToClaudeNonStream(context.Background(), "gpt-6-sol", f.Request, f.ExpectedRequest, event, &param); len(result) > 0 {
				f.ExpectedResponse = result
			}
		}
	}
	output, err := json.MarshalIndent(input, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(output))
}

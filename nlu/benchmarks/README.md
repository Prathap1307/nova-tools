# Local Qwen3 comparison

Both models used Q8_0 weights, llama.cpp, a 2048-token context, four CPU
threads, temperature 0, and the same prompt and 22 synthetic benchmark cases.
This laptop has approximately 8 GB RAM. The served 1.7B model identity was
checked through the server's model metadata before the final run.

| Model | Exact match | English | Tamil | Tanglish | Intent correct |
| --- | --- | --- | --- | --- | --- |
| Qwen3 0.6B | 1/22 | 1/10 | 0/6 | 0/6 | 5/22 |
| Qwen3 1.7B | 6/22 | 3/10 | 2/6 | 1/6 | 9/22 |

Exact match requires all five fields to agree with the expectation. Intent
accuracy considers just the intent field. These measurements cover request
parsing on a small hand-authored set. General conversation and other languages
need their own evaluation.

Reproduce with the selected GGUF model served on localhost:8080:

```powershell
npm run --silent nlu -- --runtime llama --model qwen3-1.7b --output result.json
```

The 1.7B output and comparison JSON are saved alongside this file. Both runs
have substantial errors. The results support further evaluation and prompt
development before using either setup to dispatch business tools.

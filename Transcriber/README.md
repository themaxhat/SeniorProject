# Live Transcriber

A small Python program that listens to your microphone and prints what you say in the terminal in real time. It uses [Vosk](https://alphacephei.com/vosk/) for offline speech recognition, so no internet connection or API key is needed after the first run.

While you're speaking, the current line updates live. When you pause, the sentence is finalized and printed on its own line.

## Requirements

- Python 3.9 or newer (3.11 or 3.12 recommended)
- A working microphone
- Run this on your own computer, **not** inside a Codespace, dev container, or WSL, since those usually can't access your microphone

## Setup

### Windows (PowerShell)

```powershell
cd path\to\SeniorProject
python -m venv .venv
.venv\Scripts\activate
pip install vosk sounddevice
```

If activation fails with a "running scripts is disabled" error, run this once and try again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### macOS / Linux

```bash
cd path/to/SeniorProject
python3 -m venv .venv
source .venv/bin/activate
pip install vosk sounddevice
```

On Linux you may also need PortAudio:

```bash
sudo apt install libportaudio2
```

## Run

With the virtual environment activated (you should see `(.venv)` in your prompt):

```
python live_transcribe.py
```

- The first run downloads a small English speech model, which takes a minute.
- When you see `Listening...`, start talking.
- Press **Ctrl+C** to stop.

## Troubleshooting

| Problem | Fix |
|---|---|
| `python` is not recognized | Install Python from python.org and tick **Add Python to PATH**, then reopen the terminal |
| `PortAudioError: Error querying device -1` | No microphone is available. Make sure you're running on your own machine, not a Codespace, container, or WSL |
| No text appears | Check that your OS allows desktop apps to use the microphone (Windows: Settings > Privacy & security > Microphone) |
| Wrong microphone is used | Set your preferred mic as the system default input device |
| Poor accuracy | Use a larger model: change `Model(lang="en-us")` to `Model(model_name="vosk-model-en-us-0.22")` |

## Changing the language

Pass a different language code when creating the model, for example `Model(lang="es")` for Spanish or `Model(lang="fr")` for French.
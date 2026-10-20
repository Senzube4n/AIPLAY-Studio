# AIPLAY + RunPod: beginner quick start for Windows

This setup keeps AIPLAY Studio and your finished files on your Windows PC. A RunPod GPU does the heavy image, video, or compatible music rendering, and AIPLAY downloads the result back to your PC.

You do not need an NVIDIA GPU in your PC. You do need a RunPod account with credit, a running GPU Pod, and the required models on that Pod.

## What you will set up

1. A ComfyUI Pod on RunPod.
2. A small private AIPLAY worker on that Pod.
3. A connection from AIPLAY on Windows to the worker.

AIPLAY only needs the worker's port **8787**. The worker talks to ComfyUI inside the Pod.

## Before you begin

- Install or download this AIPLAY Studio fork on your Windows PC.
- Create a [RunPod account](https://console.runpod.io/) and add credit.
- Decide whether you want to test an image or video first. **Start with a small image** because it is faster and cheaper.
- If you later use LTX video, accept the model publisher's licence on Hugging Face before downloading its files.

RunPod charges for GPU time while the Pod is running. Persistent storage can also cost money while the Pod is stopped.

## 1. Create the Pod

In the RunPod console, create a Pod from the official **ComfyUI - CUDA 13.0** template. CUDA 12.8 can also work, but use CUDA 13.0 when your selected GPU supports it.

For a reusable setup:

- Attach a persistent network volume mounted at `/workspace`.
- Expose HTTP ports `8080`, `8188`, `8787`, and `8888`.
- Choose a GPU with enough memory for your model. Image models need much less memory than large video models.
- Wait until the Pod's **Connect** page says JupyterLab on port 8888 and ComfyUI on port 8188 are ready.

The AIPLAY connection itself uses port **8787**. Port 8888 is only needed for JupyterLab during setup.

## 2. Install the AIPLAY worker

On the Pod's **Connect** page, open **JupyterLab**. In JupyterLab, choose **File → New → Terminal** and paste this entire command:

```bash
curl -fsSL https://raw.githubusercontent.com/nemesisone-dev/AIPLAY-Studio/main/worker/bootstrap-runpod.sh -o /tmp/aiplay-bootstrap.sh && bash /tmp/aiplay-bootstrap.sh
```

The script installs the worker under `/workspace`, creates a private token, and arranges for it to start with ComfyUI. It does not download a model until you explicitly choose one in AIPLAY and accept its terms.

When it finishes, it prints two lines similar to these:

```text
Worker URL: https://YOUR_POD_ID-8787.proxy.runpod.net
Worker token: a-long-private-random-value
```

Copy both values somewhere private. You can safely run the bootstrap command again after an update; it preserves the existing token.

## 3. Connect AIPLAY on Windows

1. Start AIPLAY with **AIPLAY RunPod.cmd**, or open the launcher and choose **Launch RunPod GPU**.
2. Open **Images** or **Video**.
3. In the RunPod box, click **Connection…**.
4. Paste the **Worker URL** and **Worker token** printed by the bootstrap script.
5. Click **Connect and check models**.

The connection screen should report that the worker and ComfyUI are ready and list the models found on the Pod.

The worker token is not your RunPod account API key. Keep both private. The account API key in the optional **Create or manage a RunPod Pod** section lets AIPLAY show and manage your Pods; it is not required when you manage the Pod in the RunPod website.

### Install or repair a supported model

In **RunPod connection**, expand **Install or repair models on this Pod**. For a listed model:

1. Open and review its model repository and terms.
2. Select the acceptance checkbox.
3. Click **Install**, **Resume**, or **Repair**.

AIPLAY downloads only pinned files from its curated list. The worker resumes its own interrupted download, checks the exact byte size and SHA-256 checksum, and moves the file into ComfyUI only after verification. Known invalid temporary files for that curated model are removed during an explicit repair. You can close the connection window while the download continues; reopen it to see progress.

The first supported bundle is **YuE2 3B for ComfyUI**. Image and video model bundles will appear here only after their exact files, licences and workflows have been verified.

## 4. Make the first image

1. Keep the Pod running.
2. Open **Images** in AIPLAY.
3. Select a checkpoint shown under **Model on the Pod**.
4. Choose a small size such as 512 × 512 and enter a short prompt.
5. Click the RunPod render button.

AIPLAY sends the job, waits for ComfyUI, checks the downloaded file, and adds it to your local image library. Files are saved under:

```text
%USERPROFILE%\.aiplay-studio\output\images
```

After the image works, try a short video with the **512 × 320 · cheapest test** setting. Video files are saved under:

```text
%USERPROFILE%\.aiplay-studio\output\clips
```

## 5. Create music on the RunPod GPU

The RunPod mode can send music from AIPLAY's normal **Music** screen through the same worker. The Pod must have the exact ComfyUI nodes and model files for one of these engines:

- **MiniMax Music 3**
- **ACE-Step 1.5**
- **YuE2 3B (ComfyUI)**

Connect the worker from the **Images** or **Video** screen first. Then:

1. Open **Music**.
2. Select a supported ComfyUI music engine that is installed on the Pod.
3. Enter the title, lyrics, and musical style, or choose instrumental mode.
4. Click **Create**.

AIPLAY builds the music workflow on your PC, renders it through ComfyUI on the Pod, downloads the audio, and adds it to the normal local Music library under:

```text
%USERPROFILE%\.aiplay-studio\output
```

The native **YuE2 GGUF** engine is a separate local Windows engine and is not sent to RunPod. Choose **YuE2 3B (ComfyUI)** when you want a YuE2 workflow to use the Pod.

Music model bundles are large and can have separate licences or access requirements. AIPLAY installs a bundle only after you select it and accept its terms. YuE2 has passed a complete live RunPod acceptance render and returned a verified FLAC file to the local Music library. Other music engines still need the exact models and nodes installed and independently tested.

## Normal daily use

1. Start the Pod in the RunPod console.
2. Wait until port 8787 is ready.
3. Start AIPLAY with **AIPLAY RunPod.cmd**.
4. Render and confirm the finished file is on your PC.
5. Stop the Pod manually in RunPod when you are finished to stop GPU billing.

Do not delete the persistent volume if it contains models or files you still need. Stopping a Pod can release its GPU. If RunPod migrates the Pod or gives it a new Pod ID, open the new Pod's **Connect** page and replace the Worker URL in AIPLAY with:

```text
https://NEW_POD_ID-8787.proxy.runpod.net
```

The token normally remains the same when the persistent `/workspace` volume is preserved.

## Common problems

| Message or symptom | What to check |
| --- | --- |
| Worker unavailable | The Pod must be running and port 8787 must be ready. Check that the URL contains the current Pod ID. |
| Token rejected | Paste the worker token printed by the bootstrap, not the RunPod account API key. |
| ComfyUI unavailable | Wait for port 8188 to become ready, then reconnect. |
| No models listed | Open **RunPod connection → Install or repair models on this Pod**. If the model is not curated there yet, install it in the Pod's actual ComfyUI model folder, then refresh ComfyUI. |
| Model or node missing | The selected workflow needs a model file or custom node that is not installed on the Pod. |
| Music Create is unavailable or fails validation | Select MiniMax Music 3, ACE-Step 1.5, or YuE2 3B (ComfyUI), and install that engine's exact models and nodes on the Pod. Native YuE2 GGUF runs locally. |
| Connection broke after migration | Change the Worker URL to use the new Pod ID. |
| Render finished but is not visible | Return to the Images or Clips library and refresh the page. Also check the local output folders shown above. |

For model installation, security details, recovery, testing, and current limitations, read the [complete RunPod setup and technical guide](RUNPOD_SETUP.md).

import type {
  HistoryEntry,
  PromptSubmitResponse,
  Workflow,
} from "./types.js";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ComfyUIClientOptions {
  /** Internal URL used to reach ComfyUI (e.g. http://comfyui:8188) */
  baseUrl: string;
  /** External URL used when returning image URLs (defaults to baseUrl) */
  publicUrl?: string;
}

export interface GenerateImageParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  checkpoint: string;
}

export interface GenerateImageResult {
  promptId: string;
  imageUrls: string[];
}

export class ComfyUIClient {
  private readonly baseUrl: string;
  private readonly publicUrl: string;

  constructor(options: ComfyUIClientOptions) {
    this.baseUrl = options.baseUrl;
    this.publicUrl = options.publicUrl ?? options.baseUrl;
  }

  async generate(params: GenerateImageParams): Promise<GenerateImageResult> {
    const workflow = txt2img({
      prompt: params.prompt,
      negativePrompt: params.negativePrompt ?? "",
      width: params.width ?? 1024,
      height: params.height ?? 1024,
      steps: params.steps ?? 25,
      cfg: params.cfg ?? 7,
      seed: params.seed ?? Math.floor(Math.random() * 2 ** 32),
      checkpoint: params.checkpoint,
    });

    const submit = await this.submit(workflow);
    const entry = await this.waitForCompletion(submit.prompt_id);
    return {
      promptId: submit.prompt_id,
      imageUrls: extractImageUrls(entry, this.publicUrl),
    };
  }

  private async submit(workflow: Workflow): Promise<PromptSubmitResponse> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });
    if (!res.ok) {
      throw new Error(`ComfyUI submit failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as PromptSubmitResponse;
    if (body.node_errors && Object.keys(body.node_errors).length > 0) {
      throw new Error(`ComfyUI workflow errors: ${JSON.stringify(body.node_errors)}`);
    }
    return body;
  }

  private async waitForCompletion(promptId: string): Promise<HistoryEntry> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (res.ok) {
        const body = (await res.json()) as Record<string, HistoryEntry>;
        const entry = body[promptId];
        if (entry?.status?.completed) return entry;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`ComfyUI generation timed out (prompt ${promptId})`);
  }
}

function extractImageUrls(entry: HistoryEntry, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const output of Object.values(entry.outputs)) {
    for (const image of output.images ?? []) {
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
      });
      urls.push(`${baseUrl}/view?${params.toString()}`);
    }
  }
  return urls;
}

function txt2img(params: {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  checkpoint: string;
}): Workflow {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: params.seed,
        steps: params.steps,
        cfg: params.cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: params.checkpoint },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.negativePrompt, clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "shopify-mcp", images: ["8", 0] },
    },
  };
}

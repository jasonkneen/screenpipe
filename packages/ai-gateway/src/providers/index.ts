import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { VertexAIProvider } from './vertex';
import { GeminiProvider } from './gemini';
import { OpenRouterProvider } from './openrouter';
import { VertexMaasProvider, isVertexMaasModel } from './vertex-maas';
import { TinfoilProvider, isTinfoilModel } from './tinfoil';
import { ScreenpipeEnclaveProvider, isScreenpipeEnclaveModel } from './screenpipe-enclave';
import { AIProvider } from './base';
import { Env } from '../types';

// Remap legacy OpenRouter model IDs → Vertex MaaS equivalents (GCP infra, no China data risk)
const MODEL_REMAPS: Record<string, string> = {
	'deepseek/deepseek-chat': 'deepseek-v3.2',
	'meta-llama/llama-4-scout': 'llama-4-scout',
	'meta-llama/llama-4-maverick': 'llama-4-maverick',
	'qwen/qwen3-coder:free': 'qwen3-coder',
};

/**
 * Apply legacy → canonical model alias remap. Callers must use the returned
 * value for BOTH provider selection AND the upstream request body — earlier
 * we remapped only inside createProvider, so the body kept the legacy name
 * and Vertex MaaS rejected it ("Unknown Vertex MaaS model").
 */
export function resolveModelAlias(model: string): string {
	const remapped = MODEL_REMAPS[model];
	if (remapped) {
		console.log(`[router] remapping ${model} → ${remapped} (Vertex MaaS)`);
		return remapped;
	}
	return model;
}

// Models routed through OpenRouter (only those NOT available on Vertex MaaS)
const OPENROUTER_PREFIXES = ['deepseek/', 'qwen/', 'mistralai/', 'stepfun/'];
const OPENROUTER_MODELS = ['step-3.5', ':free'];

function isOpenRouterModel(model: string): boolean {
	const lower = model.toLowerCase();
	return OPENROUTER_PREFIXES.some(p => lower.startsWith(p)) ||
		OPENROUTER_MODELS.some(m => lower.includes(m));
}

export function createProvider(model: string, env: Env): AIProvider {
	model = resolveModelAlias(model);

	// Screenpipe event classifier — routes to self-hosted vLLM
	if (model === 'screenpipe-event-classifier') {
		const vllmUrl = env.EVENT_CLASSIFIER_URL || 'http://34.122.128.37:8080/v1';
		return new OpenAIProvider('none', vllmUrl);
	}
	if (model.toLowerCase().includes('claude')) {
		if (!env.ANTHROPIC_API_KEY) {
			throw new Error('Anthropic API key not configured');
		}
		return new AnthropicProvider(env.ANTHROPIC_API_KEY);
	}
	if (model.toLowerCase().includes('gemini')) {
		// Prefer Vertex AI for Gemini (shorter data retention, enterprise ToS)
		if (env.VERTEX_SERVICE_ACCOUNT_JSON && env.VERTEX_PROJECT_ID) {
			return new GeminiProvider({
				serviceAccountJson: env.VERTEX_SERVICE_ACCOUNT_JSON,
				projectId: env.VERTEX_PROJECT_ID,
				region: 'us-central1',
			});
		}
		// Fallback to API key if Vertex credentials unavailable
		if (!env.GEMINI_API_KEY) {
			throw new Error('Gemini API key not configured');
		}
		return new GeminiProvider(env.GEMINI_API_KEY);
	}
	// Vertex AI MaaS — GLM-4.7, GLM-5, Kimi K2.5, DeepSeek, Llama, Qwen (burns GCP credits, free for users)
	if (isVertexMaasModel(model)) {
		if (!env.VERTEX_SERVICE_ACCOUNT_JSON || !env.VERTEX_PROJECT_ID) {
			throw new Error('Vertex AI credentials not configured');
		}
		return new VertexMaasProvider(env.VERTEX_SERVICE_ACCOUNT_JSON, env.VERTEX_PROJECT_ID);
	}
	// Tinfoil — confidential inference in secure enclaves (TEE)
	if (isTinfoilModel(model)) {
		if (!env.TINFOIL_API_KEY) {
			throw new Error('Tinfoil API key not configured');
		}
		return new TinfoilProvider(env.TINFOIL_API_KEY);
	}
	// Screenpipe enclave — our own Tinfoil-hosted CVM serving Gemma 4 E4B
	// (audio + vision + chat) alongside the privacy-filter. Tinfoil tokens
	// are org-scoped so TINFOIL_API_KEY works against this shim too; we
	// only require a dedicated SCREENPIPE_ENCLAVE_API_KEY if it's set.
	if (isScreenpipeEnclaveModel(model)) {
		const key = env.SCREENPIPE_ENCLAVE_API_KEY || env.TINFOIL_API_KEY;
		if (!key) {
			throw new Error('No Tinfoil API key configured (need SCREENPIPE_ENCLAVE_API_KEY or TINFOIL_API_KEY)');
		}
		return new ScreenpipeEnclaveProvider(key);
	}
	if (isOpenRouterModel(model)) {
		if (!env.OPENROUTER_API_KEY) {
			throw new Error('OpenRouter API key not configured');
		}
		return new OpenRouterProvider(env.OPENROUTER_API_KEY);
	}
	return new OpenAIProvider(env.OPENAI_API_KEY);
}

export type { AIProvider };

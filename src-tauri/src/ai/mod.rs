pub mod chain;
pub mod error;
pub mod error_classify;
pub mod http;
pub mod media_store;
pub mod oss_store;
pub mod providers;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use tracing::info;

use error::AIError;
use serde::{Deserialize, Serialize};

/// serde derives：降级链需把原始请求序列化进 ai_generation_jobs.chain_meta_json
/// （hop 重提交以此为底、仅替换模型名；终态剥除，见 ai/chain.rs）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone)]
pub struct ProviderTaskHandle {
    pub task_id: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub enum ProviderTaskSubmission {
    Queued(ProviderTaskHandle),
    Succeeded(String),
}

#[derive(Debug, Clone)]
pub enum ProviderTaskPollResult {
    Running,
    Succeeded(String),
    Failed(String),
}

#[async_trait::async_trait]
pub trait AIProvider: Send + Sync {
    fn as_any(&self) -> &dyn std::any::Any;
    fn name(&self) -> &str;
    fn supports_model(&self, model: &str) -> bool;

    fn list_models(&self) -> Vec<String> {
        Vec::new()
    }

    async fn set_api_key(&self, _api_key: String) -> Result<(), AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support API key configuration",
            self.name()
        )))
    }

    fn supports_task_resume(&self) -> bool {
        false
    }

    async fn submit_task(&self, _request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support resumable task submission",
            self.name()
        )))
    }

    async fn poll_task(&self, _handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support resumable task polling",
            self.name()
        )))
    }

    async fn reverse_prompt(
        &self,
        _image: String,
        _language: Option<String>,
        _format: Option<String>,
        _model: Option<String>,
    ) -> Result<String, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support reverse prompt",
            self.name()
        )))
    }

    async fn craft_image_prompt(
        &self,
        _user_input: &str,
        _category: Option<&str>,
        _model: Option<&str>,
        _language: Option<&str>,
    ) -> Result<String, AIError> {
        Err(AIError::Provider(format!(
            "Provider '{}' does not support craft image prompt",
            self.name()
        )))
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError>;
}

pub struct ProviderRegistry {
    providers: RwLock<HashMap<String, Arc<dyn AIProvider>>>,
    default_provider: RwLock<Option<String>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: RwLock::new(HashMap::new()),
            default_provider: RwLock::new(None),
        }
    }

    pub fn register_provider(&self, provider: Arc<dyn AIProvider>) {
        let name = provider.name().to_string();
        info!("Registering AI provider: {}", name);
        let mut providers = self.providers.write().expect("provider registry poisoned");
        providers.insert(name.clone(), provider);
        let mut default = self.default_provider.write().expect("provider registry poisoned");
        if default.is_none() {
            *default = Some(name);
        }
    }

    /// Register a runtime custom provider. Returns the provider id used.
    pub fn register_custom_provider(&self, id: String, provider: Arc<dyn AIProvider>) {
        info!("Registering custom provider: {}", id);
        let mut providers = self.providers.write().expect("provider registry poisoned");
        providers.insert(id, provider);
    }

    /// Remove a runtime custom provider by id. Returns true if it was present.
    pub fn remove_custom_provider(&self, id: &str) -> bool {
        info!("Removing custom provider: {}", id);
        let mut providers = self.providers.write().expect("provider registry poisoned");
        providers.remove(id).is_some()
    }

    /// Look up a provider and apply a closure to it (sync read lock held during the call).
    pub fn with_provider<R>(
        &self,
        name: &str,
        f: impl FnOnce(&Arc<dyn AIProvider>) -> R,
    ) -> Option<R> {
        let providers = self.providers.read().expect("provider registry poisoned");
        providers.get(name).map(f)
    }

    pub fn get_provider(&self, name: &str) -> Option<Arc<dyn AIProvider>> {
        self.providers
            .read()
            .expect("provider registry poisoned")
            .get(name)
            .cloned()
    }

    pub fn get_default_provider(&self) -> Option<Arc<dyn AIProvider>> {
        let name = self
            .default_provider
            .read()
            .expect("provider registry poisoned")
            .clone()?;
        self.providers
            .read()
            .expect("provider registry poisoned")
            .get(&name)
            .cloned()
    }

    pub fn list_providers(&self) -> Vec<String> {
        let mut providers = self
            .providers
            .read()
            .expect("provider registry poisoned")
            .keys()
            .cloned()
            .collect::<Vec<String>>();
        providers.sort();
        providers
    }

    pub fn resolve_provider_for_model(&self, model: &str) -> Option<Arc<dyn AIProvider>> {
        let providers = self.providers.read().expect("provider registry poisoned");
        if let Some((provider_id, _)) = model.split_once('/') {
            if let Some(provider) = providers.get(provider_id) {
                return Some(provider.clone());
            }
        }
        providers
            .values()
            .find(|provider| provider.supports_model(model))
            .cloned()
    }

    pub fn supports_model(&self, model: &str) -> bool {
        self.providers
            .read()
            .expect("provider registry poisoned")
            .values()
            .any(|provider| provider.supports_model(model))
    }

    pub fn list_models(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut models = Vec::new();

        for model in self
            .providers
            .read()
            .expect("provider registry poisoned")
            .values()
            .flat_map(|provider| provider.list_models())
        {
            if seen.insert(model.clone()) {
                models.push(model);
            }
        }

        models.sort();
        models
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

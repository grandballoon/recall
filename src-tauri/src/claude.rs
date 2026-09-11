//! The only module that knows about the Anthropic HTTP API.
//!
//! One job: turn "here is what they wrote, here is the span they highlighted"
//! into a typed verdict. The wire format, the model choice, and the prompt all
//! stay behind this boundary.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

const API_BASE: &str = "https://api.anthropic.com/v1";
const API_VERSION: &str = "2023-06-01";

/// Server-side refusal fallback: if a safety classifier declines the request,
/// the API re-runs it on a fallback model within the same call instead of
/// handing back an empty answer.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub const MODEL: &str = "claude-opus-5";

const MAX_TOKENS: u32 = 16_000;

/// Adaptive thinking on a hard span can take a while; this is a ceiling, not a
/// target.
const TIMEOUT: Duration = Duration::from_secs(120);

const SYSTEM_PROMPT: &str = "\
You are a precise, generous tutor helping someone test their understanding through active recall. \
They wrote an explanation from memory, highlighted one span of it, and asked you to check that span.

Assess ONLY the highlighted span. Read the surrounding text for context, but do not grade the rest of it.

Choose exactly one verdict:
- \"wrong\": the span asserts something false.
- \"imprecise\": broadly right, but vague, misleading, or sloppy in a way that matters.
- \"missing\": the span gestures at something real but omits the part that carries the meaning.
- \"solid\": the span is correct and precise enough.

Then write a note of one to three sentences. If the verdict is wrong or imprecise, say what is off and \
give the correction. If it is missing, name what a complete answer would add. If it is solid, confirm it \
crisply and add one enriching detail. Be specific to this material — never generic study advice.";

/// A failure the UI can react to differently depending on `code`.
#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn not_connected() -> Self {
        Self::new(
            "not_connected",
            "Claude is not connected yet. Add an API key in Settings.",
        )
    }

    pub fn keychain(message: String) -> Self {
        Self::new("keychain", message)
    }

    pub fn store(message: impl Into<String>) -> Self {
        Self::new("store", message)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Wrong,
    Imprecise,
    Missing,
    Solid,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Assessment {
    pub verdict: Verdict,
    pub note: String,
}

pub struct Claude {
    http: reqwest::Client,
}

impl Claude {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("failed to build the HTTP client");
        Self { http }
    }

    /// Confirms a key both authenticates and can reach the model this app uses.
    /// Costs no tokens.
    pub async fn verify_key(&self, api_key: &str) -> Result<(), Error> {
        let response = self
            .http
            .get(format!("{API_BASE}/models/{MODEL}"))
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
            .send()
            .await
            .map_err(transport_error)?;

        if response.status().is_success() {
            return Ok(());
        }
        Err(status_error(response).await)
    }

    pub async fn assess(
        &self,
        api_key: &str,
        full_text: &str,
        span: &str,
    ) -> Result<Assessment, Error> {
        let body = assess_request(full_text, span);

        let response = self
            .http
            .post(format!("{API_BASE}/messages"))
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
            .header("anthropic-beta", FALLBACK_BETA)
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?;

        if !response.status().is_success() {
            return Err(status_error(response).await);
        }

        let message: MessageResponse = response.json().await.map_err(|e| {
            Error::new(
                "malformed",
                format!("Could not read Claude's response: {e}"),
            )
        })?;

        message.into_assessment()
    }
}

/// The Messages API request for one span check.
///
/// Split out from the call so the wire shape can be asserted in tests without
/// spending a token.
fn assess_request(full_text: &str, span: &str) -> serde_json::Value {
    json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "thinking": { "type": "adaptive" },
        "fallbacks": "default",
        "output_config": {
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "verdict": {
                            "type": "string",
                            "enum": ["wrong", "imprecise", "missing", "solid"]
                        },
                        "note": { "type": "string" }
                    },
                    "required": ["verdict", "note"],
                    "additionalProperties": false
                }
            }
        },
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": format!(
                        "Their full explanation:\n\n<explanation>\n{full_text}\n</explanation>"
                    ),
                    // Checking several spans of one unedited page replays this
                    // prefix; the breakpoint lets those checks read it from cache.
                    "cache_control": { "type": "ephemeral" }
                },
                {
                    "type": "text",
                    "text": format!("The highlighted span to assess:\n\n<span>\n{span}\n</span>")
                }
            ]
        }]
    })
}

#[derive(Deserialize)]
struct MessageResponse {
    content: Vec<ContentBlock>,
    stop_reason: Option<String>,
}

/// Thinking blocks (and, on a rescued refusal, a fallback block) precede the
/// answer, so the text block has to be picked out rather than indexed.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(other)]
    Other,
}

impl MessageResponse {
    fn into_assessment(self) -> Result<Assessment, Error> {
        match self.stop_reason.as_deref() {
            Some("refusal") => {
                return Err(Error::new(
                    "refusal",
                    "Claude declined to assess this passage.",
                ))
            }
            Some("max_tokens") => {
                return Err(Error::new(
                    "malformed",
                    "Claude's answer was cut off before it finished.",
                ))
            }
            _ => {}
        }

        let text = self
            .content
            .into_iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => Some(text),
                ContentBlock::Other => None,
            })
            .ok_or_else(|| Error::new("malformed", "Claude returned no answer."))?;

        // The request constrains the output to the schema above, so anything
        // unparseable here is a genuine surprise rather than a formatting slip.
        serde_json::from_str(&text).map_err(|e| {
            Error::new(
                "malformed",
                format!("Claude's answer did not match the expected shape: {e}"),
            )
        })
    }
}

fn transport_error(e: reqwest::Error) -> Error {
    if e.is_timeout() {
        Error::new(
            "network",
            "Claude took too long to answer. Try that span again.",
        )
    } else {
        Error::new("network", format!("Could not reach Claude: {e}"))
    }
}

/// Maps a non-2xx response onto a code the UI can act on.
async fn status_error(response: reqwest::Response) -> Error {
    let status = response.status().as_u16();
    let detail = api_message(response).await;

    match status {
        401 | 403 => Error::new(
            "auth",
            "That API key was rejected. Check it in Settings, or create a new one.",
        ),
        404 => Error::new(
            "no_model_access",
            format!("The key works, but it cannot reach {MODEL}."),
        ),
        429 => Error::new(
            "rate_limited",
            "Rate limited by the API. Wait a moment and try again.",
        ),
        500 | 529 => Error::new(
            "overloaded",
            "The API is busy right now. Try that span again.",
        ),
        _ => Error::new("api", format!("The API returned {status}: {detail}")),
    }
}

/// Pulls `error.message` out of an API error body, falling back to whatever the
/// body actually was.
async fn api_message(response: reqwest::Response) -> String {
    let body = response.text().await.unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: serde_json::Value) -> Result<Assessment, Error> {
        serde_json::from_value::<MessageResponse>(body)
            .expect("test fixture should deserialize")
            .into_assessment()
    }

    #[test]
    fn request_pins_the_wire_contract() {
        let body = assess_request("the whole page", "the span");

        assert_eq!(body["model"], MODEL);
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["thinking"]["type"], "adaptive");
        // Opt-in refusal fallback; paired with the beta header on the request.
        assert_eq!(body["fallbacks"], "default");

        let schema = &body["output_config"]["format"]["schema"];
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["verdict", "note"]));
        assert_eq!(
            schema["properties"]["verdict"]["enum"],
            serde_json::json!(["wrong", "imprecise", "missing", "solid"])
        );
    }

    #[test]
    fn request_sends_the_page_whole_and_caches_it_ahead_of_the_span() {
        let page = "a".repeat(20_000);
        let body = assess_request(&page, "the span");
        let content = body["messages"][0]["content"].as_array().unwrap();

        assert_eq!(content.len(), 2);
        // The page is never truncated, and carries the cache breakpoint so a
        // second check on the same page reads it from cache.
        assert!(content[0]["text"].as_str().unwrap().contains(&page));
        assert_eq!(content[0]["cache_control"]["type"], "ephemeral");
        assert!(content[1]["text"].as_str().unwrap().contains("the span"));
        assert!(content[1].get("cache_control").is_none());
    }

    #[test]
    fn reads_the_answer_past_a_thinking_block() {
        let assessment = parse(serde_json::json!({
            "stop_reason": "end_turn",
            "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "text", "text": r#"{"verdict":"solid","note":"Right, and Kepler's second law is why."}"# }
            ]
        }))
        .expect("should parse");

        assert!(matches!(assessment.verdict, Verdict::Solid));
        assert!(assessment.note.starts_with("Right,"));
    }

    #[test]
    fn every_verdict_round_trips() {
        for (wire, expected) in [
            ("wrong", Verdict::Wrong),
            ("imprecise", Verdict::Imprecise),
            ("missing", Verdict::Missing),
            ("solid", Verdict::Solid),
        ] {
            let assessment = parse(serde_json::json!({
                "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": format!(r#"{{"verdict":"{wire}","note":"n"}}"#) }]
            }))
            .expect("should parse");
            assert_eq!(
                std::mem::discriminant(&assessment.verdict),
                std::mem::discriminant(&expected),
                "verdict {wire} did not round-trip"
            );
        }
    }

    #[test]
    fn a_refusal_is_not_reported_as_a_verdict() {
        let error = parse(serde_json::json!({
            "stop_reason": "refusal",
            "content": []
        }))
        .expect_err("a refusal is not an assessment");
        assert_eq!(error.code, "refusal");
    }

    #[test]
    fn a_truncated_answer_is_flagged_rather_than_parsed() {
        let error = parse(serde_json::json!({
            "stop_reason": "max_tokens",
            "content": [{ "type": "text", "text": r#"{"verdict":"sol"# }]
        }))
        .expect_err("a cut-off answer is not an assessment");
        assert_eq!(error.code, "malformed");
    }

    #[test]
    fn an_answer_with_no_text_block_is_flagged() {
        let error = parse(serde_json::json!({
            "stop_reason": "end_turn",
            "content": [{ "type": "thinking", "thinking": "" }]
        }))
        .expect_err("no text block means no assessment");
        assert_eq!(error.code, "malformed");
    }
}

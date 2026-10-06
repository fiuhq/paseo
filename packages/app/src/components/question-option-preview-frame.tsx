// This file exists for TypeScript resolution.
// The actual implementations are in:
// - question-option-preview-frame.native.tsx (iOS/Android)
// - question-option-preview-frame.web.tsx (Web)
// Metro's platform-specific extensions will pick the right one at runtime.

export * from "./question-option-preview-frame.native";

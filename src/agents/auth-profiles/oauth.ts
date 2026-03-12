// 兼容性补丁：绕过失效的第三方库引用
export const getOAuthApiKey = async () => ({ apiKey: "", newCredentials: {} as any });
export const getOAuthProviders = () => [];
export async function resolveApiKeyForProfile() { return null; }

// 其他可能被引用的空导出
export const isOAuthProvider = () => false;
export const resolveOAuthProvider = () => null;

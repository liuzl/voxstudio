import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthGateView } from "./AuthGate";
import { useI18n } from "./i18n";

const noAction = (): void => {};
const noAsyncAction = async (): Promise<void> => {};

beforeEach(() => {
  useI18n.setState({ locale: "zh" });
});

describe("AuthGate surface", () => {
  test("an unknown deployment state fails closed with a retry surface", () => {
    const html = renderToStaticMarkup(
      <AuthGateView status="unavailable" doors={{ password: false, providers: [] }} onRetry={noAction} onAuthenticated={noAsyncAction}>
        <div>private studio</div>
      </AuthGateView>,
    );
    expect(html).toContain("网关离线");
    expect(html).toContain("刷新");
    expect(html).not.toContain("private studio");
  });

  test("a hosted password door renders the unified product entrance", () => {
    const html = renderToStaticMarkup(
      <AuthGateView status="signed-out" doors={{ password: true, providers: ["github"] }} onRetry={noAction} onAuthenticated={noAsyncAction}>
        <div>private studio</div>
      </AuthGateView>,
    );
    expect(html).toContain("VoxStudio");
    expect(html).toContain("语音助手");
    expect(html).toContain("用 GitHub 登录");
    expect(html).toContain("显示密码");
    expect(html).not.toContain("自托管语音工作台");
    expect(html).not.toContain("private studio");
  });

  test("a signed-in account reaches the studio", () => {
    expect(renderToStaticMarkup(
      <AuthGateView status="signed-in" doors={{ password: true, providers: [] }} onRetry={noAction} onAuthenticated={noAsyncAction}>
        <div>private studio</div>
      </AuthGateView>,
    )).toContain("private studio");
  });
});

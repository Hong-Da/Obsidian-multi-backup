// 凭据设置项：用 Obsidian 自带的 SecretComponent 选择或新建本机密钥，设置里只保存密钥名。
// SecretComponent 只显示一串圆点，看不出用的是哪个密钥，所以在它左边加上密钥名。

import { SecretComponent, Setting, type App } from "obsidian";

export function addSecretSetting(
  containerEl: HTMLElement,
  app: App,
  o: { name: string; desc: string; value: string; onChange: (secretName: string) => void },
): Setting {
  const setting = new Setting(containerEl).setName(o.name).setDesc(o.desc);
  setting.settingEl.addClass("mb-secret");
  setting.addComponent((el) => {
    const nameEl = el.createSpan({ cls: "mb-secret-name" });
    const showName = (v: string) => {
      nameEl.setText(v);
      nameEl.toggle(!!v);
    };
    showName(o.value);
    return new SecretComponent(app, el).setValue(o.value).onChange((v) => {
      showName(v ?? "");
      o.onChange(v ?? "");
    });
  });
  return setting;
}

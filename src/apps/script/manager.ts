import axios from "axios";
import { MessageCallback, MsgCenter } from "@App/apps/msg-center/msg-center";
import { AppEvent, ScriptExec, ScriptRunStatusChange, ScriptStatusChange, ScriptStop, ScriptUninstall, ScriptReinstall, ScriptValueChange, TabRemove, RequestTabRunScript, ScriptInstall, RequestInstallInfo, ScriptCheckUpdate, RequestConfirmInfo, ListenGmLog, SubscribeUpdate, Unsubscribe, SubscribeCheckUpdate } from "@App/apps/msg-center/event";
import { dealScript, get, Page, randomString } from "@App/pkg/utils";
import { App } from "../app";
import { UrlMatch } from "@App/pkg/match";
import { ValueModel } from "@App/model/value";
import { ResourceManager } from "../resource";
import { ScriptCache, Script, SCRIPT_STATUS_ENABLE, SCRIPT_STATUS_DISABLE, SCRIPT_TYPE_CRONTAB, SCRIPT_TYPE_BACKGROUND, SCRIPT_RUN_STATUS_RUNNING, SCRIPT_RUN_STATUS_COMPLETE, SCRIPT_TYPE_NORMAL, SCRIPT_STATUS_ERROR, SCRIPT_RUN_STATUS_RETRY, SCRIPT_RUN_STATUS_ERROR, SCRIPT_STATUS_DELETE } from "@App/model/do/script";
import { Value } from "@App/model/do/value";
import { ScriptModel } from "@App/model/script";
import { Background } from "./background";
import { copyScript, loadScriptByUrl, parseMetadata } from "./utils";
import { ScriptUrlInfo } from "../msg-center/structs";
import { ConfirmParam } from "../grant/interface";
import { ScriptController } from "./controller";
import { v5 as uuidv5 } from "uuid";
import { Subscribe } from "@App/model/do/subscribe";
import { SubscribeModel } from "@App/model/subscribe";
import { SyncModel } from "@App/model/sync";
import { SycnSubscribe, SyncAction, SyncData, SyncScript } from "@App/model/do/sync";

// 脚本管理器,收到控制器消息进行实际的操作
export class ScriptManager {

    protected scriptModel = new ScriptModel();
    protected subscribeModel = new SubscribeModel();
    protected background = new Background();
    protected controller = new ScriptController();

    protected match = new UrlMatch<ScriptCache>();

    protected valueModel = new ValueModel();
    protected syncModel = new SyncModel();

    protected resource = new ResourceManager();

    protected changePort = new Map<any, chrome.runtime.Port[]>();
    public listenEvent() {
        // 监听值修改事件,并发送给全局
        AppEvent.listener(ScriptValueChange, async (msg: any) => {
            let { model, tabid } = msg;
            let vals: { [key: string]: Value } = {};
            let key = '';
            if (model.storageName) {
                key = "value:storagename:" + model.storageName;
                vals = await App.Cache.get(key);
            } else {
                key = "value:" + model.scriptId;
                vals = await App.Cache.get(key);
            }
            if (!vals) {
                vals = {};
                await App.Cache.set(key, vals);
            }
            vals[model.key] = model;
            this.changePort.forEach(val => {
                val.forEach(val => {
                    val.postMessage(model);
                })
            })
            // 监听值修改事件,并发送给沙盒环境
            sandbox.postMessage({ action: ScriptValueChange, value: msg }, '*');
        });
        MsgCenter.listener(ScriptValueChange, (msg, port) => {
            if (typeof msg == 'string') {
                let ports = this.changePort.get(port.sender?.tab?.id);
                if (!ports) {
                    ports = [];
                    ports.push(port);
                }
                this.changePort.set(port.sender?.tab?.id, ports);
                if (!port.sender?.frameId) {
                    port.onDisconnect.addListener(() => {
                        this.changePort.delete(port.sender?.tab?.id);
                    });
                }
            } else {
                AppEvent.trigger(ScriptValueChange, msg);
            }
        });
    }

    public listen() {

        // 消息监听处理
        this.listenerMessage(ScriptInstall, this.scriptInstall)
        this.listenerMessage(ScriptReinstall, this.scriptReinstall)
        this.listenerMessage(ScriptUninstall, this.scriptUninstall)
        this.listenerMessage(ScriptStatusChange, this.scriptStatusChange);
        this.listenerMessage(ScriptExec, this.execScript);
        this.listenerMessage(ScriptStop, this.stopScript);
        this.listenerMessage(RequestInstallInfo, this.requestInstallInfo);
        this.listenerMessage(ScriptCheckUpdate, this.scriptCheckUpdate);
        this.listenerMessage(RequestConfirmInfo, this.requestConfirmInfo);

        this.listenerMessage(SubscribeUpdate, this.subscribe);
        this.listenerMessage(Unsubscribe, this.unsubscribe);
        this.listenerMessage(SubscribeCheckUpdate, this.subscribeCheckUpdate);

        // 监听事件,并转发
        this.listenerProxy(ListenGmLog);

        // 扩展事件监听操作
        this.listenScriptInstall();
    }

    public listenScriptInstall() {
        chrome.webRequest.onBeforeRequest.addListener(
            (req: chrome.webRequest.WebRequestBodyDetails) => {
                if (req.method != "GET") {
                    return;
                }
                let hash = req.url
                    .split("#")
                    .splice(1)
                    .join("#");
                if (hash.indexOf("bypass=true") != -1) {
                    return;
                }
                this.installScript(req.tabId, req.url);
                return { redirectUrl: "javascript:void 0" };
            },
            {
                urls: [
                    "*://*/*.user.js", chrome.runtime.getURL("/") + '*.user.js',
                    "https://*/*.user.sub.js",
                ],
                types: ["main_frame"],
            },
            ["blocking"],
        );
    }

    public async installScript(tabid: number, url: string) {
        let info = await loadScriptByUrl(url);
        if (info) {
            App.Cache.set("install:info:" + info.uuid, info);
            chrome.tabs.create({
                url: "install.html?uuid=" + info.uuid,
            });
        } else {
            chrome.tabs.update(tabid, {
                url: url + "#bypass=true",
            });
        }
    }

    // 监听来自AppEvent的事件和连接来自其它地方的长链接,转发AppEvent的事件
    public listenerProxy(topic: string, callback?: (msg: any) => any) {
        // 暂时只支持一个连接
        let conns = new Map<string, chrome.runtime.Port>();
        MsgCenter.listener(topic, (msg: any, port: chrome.runtime.Port) => {
            let rand = randomString(8);
            conns.set(rand, port);
            port.onDisconnect.addListener(() => {
                conns.delete(rand);
            });
        });
        AppEvent.listener(topic, async (msg: any) => {
            if (callback) {
                msg = callback.call(this, msg);
                if (msg instanceof Promise) {
                    msg = await msg;
                }
            }
            conns.forEach(val => {
                val.postMessage(msg);
            });
        })
    }

    public listenerMessage(topic: string, callback: MessageCallback) {
        MsgCenter.listenerMessage(topic, async (body, send, sender) => {
            let ret = <any>callback.call(this, body, send, sender)
            if (ret instanceof Promise) {
                ret = await ret;
            }
            send(ret);
        });
    }

    public requestConfirmInfo(uuid: string): Promise<ConfirmParam> {
        return new Promise(resolve => {
            let info = App.Cache.get("confirm:info:" + uuid);
            resolve(info);
        });
    }

    public requestInstallInfo(uuid: string): Promise<ScriptUrlInfo> {
        return new Promise(resolve => {
            let info = App.Cache.get("install:info:" + uuid);
            resolve(info);
        });
    }

    public subscribe(sub: Subscribe): Promise<number> {
        return new Promise(async resolve => {
            // 异步处理订阅
            let old = await this.subscribeModel.findByUrl(sub.url);
            await this.subscribeModel.save(sub);
            this.subscribeUpdate(sub, old);
            this.syncSubscribeTask(sub.url, "update", sub);
            return resolve(sub.id);
        });
    }

    // 检查订阅规则是否改变,是否能够静默更新
    public checkSubscribeRule(oldSub: Subscribe, newSub: Subscribe): boolean {
        //判断connect是否改变
        let oldConnect = new Map();
        let newConnect = new Map();
        oldSub.metadata['connect'] && oldSub.metadata['connect'].forEach(val => {
            oldConnect.set(val, 1);
        });
        newSub.metadata['connect'] && newSub.metadata['connect'].forEach(val => {
            newConnect.set(val, 1);
        });
        // 老的里面没有新的就需要用户确认了
        for (const key in newConnect) {
            if (!oldConnect.has(key)) {
                return false
            }
        }
        return true;
    }

    public unsubscribe(id: number): Promise<boolean> {
        return new Promise(async resolve => {
            let sub = await this.subscribeModel.findById(id);
            if (!sub) {
                return resolve(false);
            }
            // 删除相关联脚本
            for (const key in sub.scripts) {
                let script = await this.scriptModel.findByUUID(sub.scripts[key].uuid);
                if (script && script.subscribeUrl == sub.url) {
                    this.scriptUninstall(script.id);
                }
            }
            await this.subscribeModel.delete(id);
            this.syncSubscribeTask(sub.url, "delete", sub);
            return resolve(true);
        });
    }

    public subscribeCheckUpdate(subscribeId: number): Promise<boolean> {
        return new Promise(async resolve => {
            let sub = await this.subscribeModel.findById(subscribeId);
            if (!sub) {
                return resolve(false);
            }
            this.subscribeModel.table.update(sub.id, { checktime: new Date().getTime() });
            axios.get(sub.url, {
                headers: {
                    'Cache-Control': 'no-cache'
                }
            }).then((response): string | null => {
                if (response.status != 200) {
                    App.Log.Warn("check subscribe", "subscribe:" + sub!.id + " error: respond:" + response.statusText, sub!.name);
                    return null;
                }
                let metadata = parseMetadata(response.data);
                if (metadata == null) {
                    App.Log.Error('check subscribe', 'MetaData信息错误', sub!.name);
                    return null;
                }
                if (!sub!.metadata['version']) {
                    sub!.metadata['version'] = ["v0.0.0"];
                }
                if (!metadata['version']) {
                    return null;
                }
                var regexp = /[0-9]+/g
                var oldVersion = sub!.metadata['version'][0].match(regexp);
                if (!oldVersion) {
                    oldVersion = ["0", "0", "0"];
                }
                var Version = metadata['version'][0].match(regexp);
                if (!Version) {
                    App.Log.Warn("check subscribe", "订阅脚本version格式错误:" + sub!.id, sub!.name);
                    return null;
                }
                for (let i = 0; i < Version.length; i++) {
                    if (oldVersion[i] == undefined) {
                        return response.data;
                    }
                    if (parseInt(Version[i]) > parseInt(oldVersion[i])) {
                        return response.data;
                    }
                }
                return null;
            }).then(async (val: string | null) => {
                // TODO: 解析了不知道多少次,有时间优化
                if (val) {
                    let [newSub, oldSub] = await this.controller.prepareSubscribeByCode(val, sub!.url);
                    if (newSub) {
                        // 规则通过静默更新,未通过打开窗口
                        if (this.checkSubscribeRule(<Subscribe>oldSub, newSub)) {
                            this.subscribeUpdate(newSub, <Subscribe>oldSub, true);
                        } else {
                            let info = await loadScriptByUrl(sub!.url);
                            if (info) {
                                App.Cache.set("install:info:" + info.uuid, info);
                                chrome.tabs.create({
                                    url: 'install.html?uuid=' + info.uuid,
                                    active: false,
                                });
                            }
                        }
                    }
                    resolve(true);
                } else {
                    resolve(false);
                }
            }).catch((e) => {
                App.Log.Warn("check subscribe", "subscribe:" + sub!.id + " error: " + e, sub!.name);
                resolve(false);
            });
        });
    }

    public subscribeUpdate(sub: Subscribe, old: Subscribe | undefined, changeRule?: boolean): Promise<number> {
        return new Promise(async resolve => {
            // 异步处理订阅
            let deleteScript = [];
            let addScript: string[] = [];
            let addScriptName = [];
            if (old) {
                // 存在老订阅,与新订阅比较scripts找出要删除或者新增的脚本
                sub.metadata['scripturl'].forEach(val => {
                    if (!old?.scripts[val]) {
                        // 老的不存在,新的存在,新增
                        addScript.push(val);
                    } else {
                        sub.scripts[val] = old.scripts[val];
                    }
                })
                for (let key in old.scripts) {
                    let script = await this.scriptModel.findByUUIDAndSubscribeUrl(old.scripts[key].uuid, sub.url);
                    if (script) {
                        if (!sub.scripts[key]) {
                            // 老的存在,新的不存在,删除
                            deleteScript.push(script.name);
                            this.scriptUninstall(script.id);
                        } else if (changeRule) {
                            // 修改已有的connect,可能要考虑一下手动修改了connect的情况
                            script.selfMetadata['connect'] = sub.metadata['connect'];
                            this.scriptReinstall(script);
                        }
                    }
                }
            } else {
                addScript = sub.metadata['scripturl'];
            }
            let error = [];
            for (let i = 0; i < addScript.length; i++) {
                let url = addScript[i];
                let script = await this.scriptModel.findByOriginAndSubscribeUrl(url, sub.url);
                let oldscript;
                if (!script) {
                    try {
                        [script, oldscript] = await this.controller.prepareScriptByUrl(url);
                        if (!script) {
                            App.Log.Error("subscribe", url + ":" + oldscript, sub.name + " 订阅脚本安装失败")
                            error.push(url);
                            continue;
                        }
                    } catch (e) {
                        error.push(url);
                    }
                }
                if (script!.subscribeUrl && script!.subscribeUrl != sub.url) {
                    App.Log.Warn("subscribe", script!.name + '已被\"' + script!.subscribeUrl + "\"订阅", sub.name + " 订阅冲突");
                    continue;
                }
                script!.selfMetadata['connect'] = sub.metadata['connect'];
                if (oldscript == undefined) {
                    script!.subscribeUrl = sub.url;
                    script!.status = SCRIPT_STATUS_ENABLE;
                    script!.id = await this.scriptInstall(script!);
                    addScriptName.push(script!.name);
                }
                sub.scripts[url] = {
                    uuid: script!.uuid,
                    url: url,
                };
            }
            let msg = '';
            if (addScriptName.length) {
                msg += "新增脚本:" + addScriptName.join(',') + "\n";
            }
            if (deleteScript.length) {
                msg += "删除脚本:" + deleteScript.join(',') + "\n";
            }
            if (error.length) {
                msg += "安装失败脚本:" + error.join(',');
            }
            await this.subscribeModel.save(sub);
            if (!msg) {
                return;
            }
            chrome.notifications.create({
                type: "basic",
                title: sub.name + " 订阅更新成功",
                message: msg,
                iconUrl: chrome.runtime.getURL("assets/logo.png")
            });
            App.Log.Info("subscribe", msg, sub.name + " 订阅更新成功")
            return resolve(sub.id);
        });
    }

    public scriptInstall(script: Script): Promise<number> {
        return new Promise(async resolve => {
            // 加载资源
            await this.scriptModel.save(script);
            await this.loadResouce(script);
            if (script.status == SCRIPT_STATUS_ENABLE) {
                await this.enableScript(script);
            }
            // 设置同步任务
            this.syncScriptTask(script.uuid, "update", script);
            return resolve(script.id);
        });
    }

    public scriptReinstall(script: Script): Promise<boolean> {
        return new Promise(async resolve => {
            let oldScript = await this.scriptModel.findById(script.id);
            if (!oldScript) {
                return resolve(false);
            }
            // 加载资源
            App.Cache.del('script:' + script.id);
            copyScript(script, oldScript);
            script.updatetime = new Date().getTime();
            await this.loadResouce(script);
            if (script.status == SCRIPT_STATUS_ENABLE) {
                await this.disableScript(oldScript);
                await this.enableScript(script);
            } else {
                await this.scriptModel.save(script);
            }
            // 设置同步任务
            this.syncScriptTask(script.uuid, "update", script);
            return resolve(true);
        });
    }

    public async loadResouce(script: Script) {
        return new Promise(async resolve => {
            for (let i = 0; i < script.metadata['require']?.length; i++) {
                await this.resource.addResource(script.metadata['require'][i], script.id);
            }
            for (let i = 0; i < script.metadata['require-css']?.length; i++) {
                await this.resource.addResource(script.metadata['require-css'][i], script.id);
            }
            resolve(1);
        });
    }

    public scriptUninstall(scriptId: number): Promise<boolean> {
        return new Promise(async resolve => {
            let script = await this.scriptModel.findById(scriptId);
            if (!script) {
                return resolve(false);
            }
            if (script.status == SCRIPT_STATUS_ENABLE) {
                await this.disableScript(script, true);
            }
            await this.scriptModel.delete(script.id);
            //TODO:释放资源
            App.Cache.del('script:' + script.id);
            script.metadata["require"]?.forEach((val: string) => {
                this.resource.deleteResource(val, script!.id);
            });
            script.metadata["require-css"]?.forEach((val: string) => {
                this.resource.deleteResource(val, script!.id);
            });
            // 设置同步任务
            this.syncScriptTask(script.uuid, "delete");
            return resolve(true);
        });
    }

    public scriptStatusChange(msg: any): Promise<boolean> {
        return new Promise(async resolve => {
            let script = await this.scriptModel.findById(msg.scriptId);
            if (!script) {
                return resolve(false);
            }
            if (script.status == msg.status) {
                return resolve(true);
            }
            script.status = msg.status;
            if (script.status == SCRIPT_STATUS_ENABLE) {
                await this.enableScript(script);
            } else {
                await this.disableScript(script);
            }
            return resolve(true);
        });
    }

    public execScript(msg: any): Promise<boolean> {
        return new Promise(async resolve => {
            let script = await this.scriptModel.findById(msg.scriptId);
            if (!script) {
                return resolve(false);
            }
            if (script.type == SCRIPT_TYPE_CRONTAB || script.type == SCRIPT_TYPE_BACKGROUND) {
                await this.background.execScript(await this.controller.buildScriptCache(script), msg.isdebug);
                resolve(true);
            } else {
                resolve(false);
            }
        });
    }

    public stopScript(msg: any): Promise<boolean> {
        return new Promise(async resolve => {
            let script = await this.scriptModel.findById(msg.scriptId);
            if (!script) {
                return resolve(false);
            }
            if (script.type == SCRIPT_TYPE_CRONTAB || script.type == SCRIPT_TYPE_BACKGROUND) {
                await this.background.stopScript(script, msg.isdebug);
                this.setRunComplete(script.id)
                resolve(true);
            } else {
                resolve(false);
            }
        });
    }

    public listenScriptMath() {
        AppEvent.listener(ScriptStatusChange, async (script: Script) => {
            if (script && script.type !== SCRIPT_TYPE_NORMAL) {
                return;
            }
            this.match.del(script);
            if (script.status == SCRIPT_STATUS_DELETE) {
                return;
            }
            let cache = await this.controller.buildScriptCache(script);
            cache.code = dealScript(chrome.runtime.getURL('/' + cache.name + '.user.js#uuid=' + cache.uuid), `window['${cache.flag}']=function(context){\n` +
                cache.code + `\n}`);
            script.metadata['match']?.forEach(val => {
                this.match.add(val, cache);
            });
            script.metadata['include']?.forEach(val => {
                this.match.add(val, cache);
            });
            script.metadata['exclude']?.forEach(val => {
                this.match.exclude(val, cache);
            });
        });
        let scriptFlag = randomString(8);
        this.scriptList({ type: SCRIPT_TYPE_NORMAL }).then(items => {
            items.forEach(async script => {
                let cache = await this.controller.buildScriptCache(script);
                cache.code = dealScript(chrome.runtime.getURL('/' + cache.name + '.user.js#uuid=' + cache.uuid), `window['${cache.flag}']=function(context){\n` +
                    cache.code + `\n}`);
                script.metadata['match']?.forEach(val => {
                    this.match.add(val, cache);
                });
                script.metadata['include']?.forEach(val => {
                    this.match.add(val, cache);
                });
                script.metadata['exclude']?.forEach(val => {
                    this.match.exclude(val, cache);
                });
            });
        });
        let injectedSource = '';
        get(chrome.runtime.getURL('src/injected.js'), (source: string) => {
            injectedSource = dealScript(chrome.runtime.getURL('src/injected.js'), `(function (ScriptFlag) {\n${source}\n})('${scriptFlag}')`);
        });
        chrome.runtime.onMessage.addListener((msg, detail, send) => {
            if (msg !== 'runScript') {
                return;
            }
            if (!detail.url || !detail.tab || detail.tab.id! <= 0) {
                return;
            }
            let scripts = this.match.match(detail.url);
            let filter: ScriptCache[] = [];
            scripts.forEach(script => {
                if (script.status !== SCRIPT_STATUS_ENABLE) {
                    return;
                }
                if (script.metadata['noframes']) {
                    if (detail.frameId != 0) {
                        return;
                    }
                }
                filter.push(script);
            });
            // 注入框架
            chrome.tabs.executeScript(detail.tab!.id!, {
                frameId: detail.frameId,
                code: `(function(){
                    let temp = document.createElement('script');
                    temp.setAttribute('type', 'text/javascript');
                    temp.innerHTML = "` + injectedSource + `";
                    temp.className = "injected-js";
                    document.documentElement.appendChild(temp)
                    temp.remove();
                }())`,
                runAt: "document_start",
            });
            send({ scripts: filter, flag: scriptFlag });
            if (!filter.length) {
                return;
            }
            // 角标和脚本
            chrome.browserAction.getBadgeText({
                tabId: detail.tab?.id,
            }, res => {
                chrome.browserAction.setBadgeText({
                    text: (filter.length + (parseInt(res) || 0)).toString(),
                    tabId: detail.tab?.id,
                });
            });

            chrome.browserAction.setBadgeBackgroundColor({
                color: [255, 0, 0, 255],
                tabId: detail.tab?.id,
            });
            filter.forEach(script => {
                // 注入实际脚本
                let runAt = 'document_idle';
                if (script.metadata['run-at']) {
                    runAt = script.metadata['run-at'][0];
                }
                switch (runAt) {
                    case 'document-body':
                    case 'document-menu':
                    case 'document-start':
                        runAt = 'document_start';
                        break;
                    case 'document-end':
                        runAt = 'document_end';
                        break;
                    case 'document-idle':
                        runAt = 'document_idle';
                        break;
                    default:
                        runAt = 'document_idle';
                        break;
                }
                chrome.tabs.executeScript(detail.tab!.id!, {
                    frameId: detail.frameId,
                    code: `(function(){
                        let temp = document.createElement('script');
                        temp.setAttribute('type', 'text/javascript');
                        temp.innerHTML = "` + script.code + `";
                        temp.className = "injected-js";
                        document.documentElement.appendChild(temp)
                        temp.remove();
                    }())`,
                    runAt: runAt,
                });
            });
        });
        let runMenu = new Map<number, { [key: number]: Array<any> }>();
        let bgMenu: { [key: number]: Array<any> } = {};
        AppEvent.listener("GM_registerMenuCommand", msg => {
            let param = msg.param;
            if (msg.type == "frontend") {
                let tabMenus = runMenu.get(param.tabId);
                if (!tabMenus) {
                    tabMenus = {};
                }
                let scriptMenu = tabMenus[param.scriptId];
                if (!scriptMenu) {
                    scriptMenu = new Array();
                }
                scriptMenu.push(param);
                tabMenus[param.scriptId] = scriptMenu;
                runMenu.set(param.tabId, tabMenus);
            } else {
                let scriptMenu = bgMenu[param.scriptId];
                if (!scriptMenu) {
                    scriptMenu = new Array();
                }
                scriptMenu.push(param);
                bgMenu[param.scriptId] = scriptMenu;
            }
        });
        AppEvent.listener("GM_unregisterMenuCommand", msg => {
            let param = msg.param;
            let scriptMenu: any[] = [];
            if (msg.type == "frontend") {
                let tabMenus = runMenu.get(param.tabId);
                if (tabMenus) {
                    scriptMenu = tabMenus[param.scriptId];
                }
            } else {
                scriptMenu = bgMenu[param.scriptId];
            }
            for (let i = 0; i < scriptMenu.length; i++) {
                if (scriptMenu[i].id == param.id) {
                    scriptMenu.splice(i, 1);
                }
            }
        });
        chrome.tabs.onRemoved.addListener(tabId => {
            runMenu.delete(tabId);
            AppEvent.trigger(TabRemove, tabId);
        });
        chrome.tabs.onUpdated.addListener((tabId, info) => {
            if (info.status != "loading") {
                return;
            }
            runMenu.delete(tabId);
            AppEvent.trigger(TabRemove, tabId);
        });
        this.listenerMessage(RequestTabRunScript, (val) => {
            return {
                run: this.match.match(val.url),
                runMenu: runMenu.get(val.tabId),
                bgMenu: bgMenu,
            }
        })
    }

    public enableScript(script: Script): Promise<boolean> {
        return new Promise(async resolve => {
            if (script.type == SCRIPT_TYPE_CRONTAB || script.type == SCRIPT_TYPE_BACKGROUND) {
                let ret = await this.background.enableScript(await this.controller.buildScriptCache(script));
                if (ret) {
                    script.error = ret;
                    script.status == SCRIPT_STATUS_ERROR;
                } else {
                    script.status = SCRIPT_STATUS_ENABLE;
                }
            } else {
                script.status = SCRIPT_STATUS_ENABLE;
                if (script.metadata['run-at'] && script.metadata['match'] && script.metadata['run-at'][0] == 'document-menu') {
                    // 处理menu类型脚本
                    chrome.contextMenus.create({
                        id: script.uuid,
                        title: script.name,
                        contexts: ["all"],
                        parentId: "script-cat",
                        onclick: (info, tab) => {
                            // 通信发送
                            chrome.tabs.sendMessage(tab.id!, {
                                "action": ScriptExec, "uuid": script.uuid,
                            });
                        },
                        documentUrlPatterns: script.metadata['match'],
                    });
                }
            }
            await this.scriptModel.save(script);
            AppEvent.trigger(ScriptStatusChange, script);
            return resolve(true);
        });
    }

    public disableScript(script: Script, isuninstall?: boolean): Promise<void> {
        return new Promise(async resolve => {
            if (isuninstall) {
                script.status = SCRIPT_STATUS_DELETE;
            } else {
                script.status = SCRIPT_STATUS_DISABLE;
            }
            if (script.type == SCRIPT_TYPE_CRONTAB || script.type == SCRIPT_TYPE_BACKGROUND) {
                await this.background.disableScript(script);
            } else {
                // 处理menu类型脚本
                if (script.metadata['run-at'] && script.metadata['run-at'][0] == 'document-menu') {
                    // 处理menu类型脚本
                    chrome.contextMenus.remove(script.uuid);
                }
            }
            await this.scriptModel.save(script);
            AppEvent.trigger(ScriptStatusChange, script);
            resolve();
        });
    }

    public scriptList(equalityCriterias: { [key: string]: any } | ((where: Dexie.Table) => Dexie.Collection) | undefined, page: Page | undefined = undefined): Promise<Array<Script>> {
        return new Promise(async resolve => {
            page = page || new Page(1, 20);
            if (equalityCriterias == undefined) {
                resolve(await this.scriptModel.list(page));
            } else if (typeof equalityCriterias == 'function') {
                let ret = (await this.scriptModel.list(equalityCriterias(this.scriptModel.table), page));
                resolve(ret);
            } else {
                resolve(await this.scriptModel.list(this.scriptModel.table.where(equalityCriterias), page));
            }
        });
    }

    public subscribeList(equalityCriterias: { [key: string]: any } | ((where: Dexie.Table) => Dexie.Collection) | undefined, page: Page | undefined = undefined): Promise<Array<Subscribe>> {
        return new Promise(async resolve => {
            page = page || new Page(1, 20);
            if (equalityCriterias == undefined) {
                resolve(await this.subscribeModel.list(page));
            } else if (typeof equalityCriterias == 'function') {
                let ret = (await this.subscribeModel.list(equalityCriterias(this.subscribeModel.table), page));
                resolve(ret);
            } else {
                resolve(await this.subscribeModel.list(this.subscribeModel.table.where(equalityCriterias), page));
            }
        });
    }

    public getScript(id: number): Promise<Script | undefined> {
        return this.scriptModel.findById(id);
    }

    // 设置脚本最后一次运行时间
    public setLastRuntime(id: number, time: number): Promise<boolean> {
        return new Promise(async resolve => {
            this.scriptModel.table.update(id, {
                lastruntime: time, runStatus: SCRIPT_RUN_STATUS_RUNNING
            })
            MsgCenter.connect(ScriptRunStatusChange, [id, SCRIPT_RUN_STATUS_RUNNING]);
            resolve(true);
        });
    }

    // 设置脚本运行错误
    public setRunError(id: number, error: string, time: number): Promise<boolean> {
        return new Promise(async resolve => {
            if (error !== '' && time !== 0) {
                this.scriptModel.table.update(id, { error: error, delayruntime: time, runStatus: SCRIPT_RUN_STATUS_RETRY })
                MsgCenter.connect(ScriptRunStatusChange, [id, SCRIPT_RUN_STATUS_RETRY]);
            } else {
                this.scriptModel.table.update(id, { error: error, delayruntime: time, runStatus: SCRIPT_RUN_STATUS_ERROR })
                if (error) {
                    MsgCenter.connect(ScriptRunStatusChange, [id, SCRIPT_RUN_STATUS_ERROR]);
                }
            }
            resolve(true);
        });
    }

    // 设置脚本运行完成
    public setRunComplete(id: number): Promise<boolean> {
        return new Promise(async resolve => {
            this.scriptModel.table.update(id, { error: "", runStatus: SCRIPT_RUN_STATUS_COMPLETE })
            MsgCenter.connect(ScriptRunStatusChange, [id, SCRIPT_RUN_STATUS_COMPLETE]);
            resolve(true);
        });
    }

    // 检查脚本更新
    public scriptCheckUpdate(scriptId: number): Promise<boolean> {
        return new Promise(async resolve => {
            let script = await this.getScript(scriptId);
            if (!script) {
                return resolve(false);
            }
            if (script.checkupdate_url == undefined) {
                return resolve(false);
            }
            this.scriptModel.table.update(script.id, { checktime: new Date().getTime() });
            axios.get(script.checkupdate_url, {
                headers: {
                    'Cache-Control': 'no-cache'
                }
            }).then((response): boolean => {
                if (response.status != 200) {
                    App.Log.Warn("check update", "script:" + script!.id + " error: respond:" + response.statusText, script!.name);
                    return false;
                }
                let meta = parseMetadata(response.data);
                if (!meta) {
                    App.Log.Warn("check update", "script:" + script!.id + " error: metadata format", script!.name);
                    return false;
                }
                if (!script!.metadata['version']) {
                    script!.metadata['version'] = ["0.0.0"];
                }
                if (!meta['version']) {
                    return false;
                }
                var regexp = /[0-9]+/g
                var oldVersion = script!.metadata['version'][0].match(regexp);
                if (!oldVersion) {
                    oldVersion = ["0", "0", "0"];
                }
                var Version = meta['version'][0].match(regexp);
                if (!Version) {
                    App.Log.Warn("check update", "script:" + script!.id + " error: version format", script!.name);
                    return false;
                }
                for (let i = 0; i < Version.length; i++) {
                    if (oldVersion[i] == undefined) {
                        return true;
                    }
                    if (parseInt(Version[i]) > parseInt(oldVersion[i])) {
                        return true;
                    }
                }
                return false;
            }).then(async (val) => {
                if (val) {
                    let info = await loadScriptByUrl(script!.download_url || script!.origin);
                    if (info) {
                        info.url = script!.origin;
                        info.uuid = uuidv5(info.url, uuidv5.URL)
                        App.Cache.set("install:info:" + info.uuid, info);
                        chrome.tabs.create({
                            url: 'install.html?uuid=' + info.uuid,
                            active: false,
                        });
                    }
                }
                resolve(val);
            }).catch((e) => {
                App.Log.Warn("check update", "script:" + script!.id + " error: " + e, script!.name);
                resolve(false);
            });

        })
    }

    public syncToScript(sync: SyncScript): Promise<Script | string> {
        return new Promise(async resolve => {
            let [script, old] = await this.controller.prepareScriptByCode(sync.code, sync.origin, sync.uuid);
            if (script == undefined) {
                App.Log.Error("system", sync.uuid! + ' ' + old, "脚本同步失败");
                return resolve(<string>old);
            }
            if (old) {
                script.status = (<Script>old).status;
                script.runStatus = (<Script>old).runStatus;
            }
            script.sort = sync.sort;
            script.selfMetadata = JSON.parse(sync.self_meta) || {};
            script.createtime = sync.createtime;
            script.updatetime = sync.updatetime;
            script.subscribeUrl = sync.subscribe_url
            if (script.id) {
                // 存在reinstall
                App.Cache.del('script:' + script.id);
                await this.loadResouce(script);
                if (script.status == SCRIPT_STATUS_ENABLE) {
                    await this.disableScript(<Script>old || script);
                    await this.enableScript(script);
                } else {
                    await this.scriptModel.save(script);
                }
            } else {
                // 不存在install
                await this.scriptModel.save(script);
                await this.loadResouce(script);
                if (script.status == SCRIPT_STATUS_ENABLE) {
                    await this.enableScript(script);
                }
            }
            return resolve(script);
        });
    }

    public syncScriptTask(uuid: string, action: SyncAction, script?: Script): Promise<any> {
        return new Promise(resolve => {
            // 设置同步任务
            chrome.storage.local.get(['currentUser', 'currentDevice'], async (items) => {
                if (!items['currentUser'] || !items['currentDevice']) {
                    return resolve(1);
                }
                let sync = await this.syncModel.findByKey(uuid);
                let data: SyncData = {
                    action: action,
                    actiontime: new Date().getTime(),
                    uuid: uuid,
                };
                if (action == "update") {
                    data.script = {
                        name: script!.name,
                        uuid: script!.uuid,
                        code: script!.code,
                        meta_json: JSON.stringify(script!.metadata),
                        self_meta: JSON.stringify(script!.selfMetadata),
                        origin: script!.origin,
                        sort: script!.sort,
                        subscribe_url: script!.subscribeUrl,
                        type: script!.type,
                        createtime: script!.createtime,
                        updatetime: script!.updatetime,
                    };
                }
                if (!sync) {
                    sync = {
                        id: 0,
                        key: uuid,
                        user: items['currentUser'],
                        device: items['currentDevice'],
                        type: 'script',
                        data: data,
                        createtime: new Date().getTime(),
                    };
                } else {
                    sync.data = data
                    sync.createtime = new Date().getTime();
                }
                await this.syncModel.save(sync);
                return resolve(1);
            });
        });
    }

    public syncSubscribeTask(url: string, action: SyncAction, subscribe?: Subscribe): Promise<any> {
        return new Promise(resolve => {
            // 设置同步任务
            chrome.storage.local.get(['currentUser', 'currentDevice'], async (items) => {
                if (!items['currentUser'] || !items['currentDevice']) {
                    return resolve(1);
                }
                let sync = await this.syncModel.findByKey(url);
                let data: SyncData = {
                    action: action,
                    actiontime: new Date().getTime(),
                    url: url,
                };
                if (action == "update") {
                    data.subscribe = {
                        name: subscribe!.name,
                        url: subscribe!.url,
                        code: subscribe!.code,
                        meta_json: JSON.stringify(subscribe!.metadata),
                        scripts: JSON.stringify(subscribe!.scripts),
                        createtime: subscribe!.createtime,
                        updatetime: subscribe!.updatetime,
                    };
                }
                if (!sync) {
                    sync = {
                        id: 0,
                        key: url,
                        user: items['currentUser'],
                        device: items['currentDevice'],
                        type: 'subscribe',
                        data: data,
                        createtime: new Date().getTime(),
                    };
                } else {
                    sync.data = data
                    sync.createtime = new Date().getTime();
                }
                await this.syncModel.save(sync);
                return resolve(1);
            });
        });
    }

    public syncToSubscribe(sync: SycnSubscribe): Promise<Subscribe | string> {
        return new Promise(async resolve => {
            let [subscribe, old] = await this.controller.prepareSubscribeByCode(sync.code, sync.url);
            if (subscribe == undefined) {
                App.Log.Error("system", sync.url! + ' ' + old, "订阅同步失败");
                return resolve(<string>old);
            }
            if (old) {
                subscribe.status = (<Subscribe>old).status;
            }
            subscribe.scripts = JSON.parse(sync.scripts);
            subscribe.createtime = sync.createtime;
            subscribe.updatetime = sync.updatetime;
            // 订阅直接save即可,不需要安装等操作
            await this.subscribeModel.save(subscribe);
            return resolve(subscribe);
        });
    }

}
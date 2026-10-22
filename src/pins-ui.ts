import type { BackendConfig } from './rooms';
import type { Session, RoomStatus } from './membership';
import { activeSession, acceptReply, statusMessages } from './membership';
import type { FriendSource } from './friends-ui';
import type { SharedPin, PinChange, PinReply } from './pins';
import { pinAction, pinFields } from './pins';
import { locationFresh } from './location';
import { Compass } from './compass';
import { degrees, directionTo, distanceLabel } from './friends';
import { PinMap } from './pin-map';
import { demoKey, savedDemoKey, DEMO_KEY_STORAGE } from './google-maps';
import type { MapPoint, MapsSDK } from './google-maps';

const html = (v: string) => v.replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const key = (s: Session | null) => s ? `${s.membership.roomId}:${s.membership.participantId}` : '';
const text = (e: Element, v: string) => { if (e.textContent !== v) e.textContent = v; };
export class PinsUI {
  private session: Session | null = null;
  private scope = '';
  private generation = 0;
  private pins: SharedPin[] = [];
  private mainId: string | null = null;
  private selected: string | null = null;
  private followMain = true;
  private revision = -1;
  private received = 0;
  private ready = false;
  private reading = false;
  private saving = false;
  private pending: PinChange | null = null;
  private message = '';
  private connectionError = false;
  private editing: SharedPin | null = null;
  private deleting: SharedPin | null = null;
  private draft = {name:'',latitude:'',longitude:''};
  private compass: Compass;
  private mapPicker: PinMap;
  private mapSetupMessage = '';
  constructor(private config: BackendConfig | null, private source: () => FriendSource | null,
    private redraw: () => void, compass?: Compass, private onTerminal?: (status: RoomStatus) => void,
    mapLoader?: (key: string) => Promise<MapsSDK>) {
    this.compass = compass ?? new Compass(() => this.paint());
    this.mapPicker = new PinMap((point,scope) => {
      if(scope!==key(this.current()) || this.saving || this.pending)return;
      this.captureDraft();this.draft.latitude=String(point.lat);this.draft.longitude=String(point.lng);
      const latitude=document.querySelector<HTMLInputElement>('#pin-latitude'),longitude=document.querySelector<HTMLInputElement>('#pin-longitude');
      if(latitude && longitude){latitude.value=this.draft.latitude;longitude.value=this.draft.longitude;}
      this.paint();
    },(id,scope) => {if(scope!==key(this.current()))return;this.selected=id;this.followMain=false;this.deleting=null;this.paint();},
    () => this.paint(),mapLoader);
    window.setInterval(() => void this.sync(),5000);
    window.setInterval(() => { this.scopeCheck(); this.paint(); },250);
    window.addEventListener('online',() => void this.sync());
    document.addEventListener('visibilitychange',() => {if (!document.hidden) void this.sync();});
  }
  private current(): Session | null {
    try { const s=this.config && activeSession(localStorage,this.config.url);return s?.snapshot && !s.pendingLeave ? s : null; }
    catch {return null;}
  }
  private pendingKey(): string {return `syu-go:${this.config?.url}:pin-change:${this.scope}`;}
  private scopeCheck(): void {
    const s=this.current();if(key(s)===this.scope)return;
    this.session=s;this.scope=key(s);this.generation++;this.pins=[];this.mainId=null;this.selected=null;
    this.followMain=true;this.revision=-1;this.received=0;this.ready=false;this.reading=false;this.saving=false;
    this.pending=null;this.editing=null;this.deleting=null;this.draft={name:'',latitude:'',longitude:''};this.message='';this.connectionError=false;
    this.mapPicker.update({scope:this.scope,pins:[],selected:null,draft:null,enabled:false});
    try {const raw=localStorage.getItem(this.pendingKey());if(raw)this.pending=JSON.parse(raw) as PinChange;}
    catch {this.message='前回の保存情報を確認できません。ブラウザーの保存設定を確認してください。';}
  }
  enter(): void {this.scopeCheck();this.followMain=true;this.selected=this.mainId;void this.sync();}
  content(): string {
    this.scopeCheck();
    return `<section class="card" aria-labelledby="pins-heading"><p class="eyebrow">MEETING POINT</p><h2 id="pins-heading">集合地点へ向かおう。</h2>
      <p class="hint">このルームの全員が地点を追加・変更・削除できます。地点はルーム内で共有されます。</p>
      <p id="pins-status" role="status"></p><button id="pin-retry" class="button secondary" type="button" hidden>前回の操作結果を再確認する</button>
      <label for="pin-select">向かう集合地点</label><select id="pin-select"></select>
      <button id="pin-compass" class="button secondary" type="button">コンパスを有効にする・再試行</button><p id="pin-compass-status" class="hint" role="status"></p>
      <div id="pin-guidance" aria-live="off"></div>
      <div class="pin-actions"><button id="pin-main" class="button secondary" type="button">メイン集合地点にする</button><button id="pin-edit" class="button secondary" type="button">地点を変更する</button><button id="pin-delete" class="button secondary" type="button">地点を削除する</button></div>
      <div id="pin-delete-confirm" class="notice" hidden><p id="pin-delete-name"></p><button id="pin-delete-yes" class="button" type="button">この地点を削除する</button><button id="pin-delete-no" class="button secondary" type="button">やめる</button></div>
      <details class="map-settings" ${savedDemoKey(localStorage)?'':'open'}><summary>確認用の地図設定</summary>
        <p class="hint">GoogleのDemo Keyを使います。課金設定のないDemo Keyを取得してください。地図の利用上限に達すると、その日の地図利用は停止します。</p>
        <a class="text-link" href="https://developers.google.com/maps/demo-key" target="_blank" rel="noopener noreferrer">Google公式ページでDemo Keyを取得 ↗</a>
        <form id="demo-key-form"><label for="google-demo-key">Demo Key</label><input id="google-demo-key" type="password" autocomplete="off" spellcheck="false" placeholder="${savedDemoKey(localStorage)?'登録済み。変更する場合だけ入力':'取得したDemo Keyを貼り付け'}">
          <button class="button secondary" type="submit">このブラウザーに保存して地図を開く</button></form>
        <button id="demo-key-remove" class="button secondary" type="button">保存したキーを消す</button><p id="demo-key-status" class="hint" role="status"></p>
        <p class="hint">キーはこのブラウザーだけに保存し、地図の読み込み時にGoogleへ送信します。スマホではスマホ側にも設定してください。課金設定や有料キーへの切り替えは行いません。</p>
      </details>
      <form id="pin-form" novalidate><h3 id="pin-form-heading">${this.editing?'集合地点を変更':'集合地点を追加'}</h3>
        <label for="pin-name">地点名</label><input id="pin-name" required value="${html(this.draft.name)}" aria-describedby="pin-form-help">
        <p id="pin-form-help" class="hint">地図をタップして仮ピンを置き、地点名を入力して登録してください。位置を変えたい場合はタップし直すか仮ピンをドラッグできます。登録するまでルームには共有されません。</p>
        <button id="pin-map-open" class="button secondary" type="button">地図を開く・再試行</button>
        <p id="pin-map-status" class="hint" role="status"></p><button id="pin-map-reload" class="button secondary" type="button">画面を再読み込みする</button>
        <div id="pin-map-slot"></div><p id="pin-picked-position" class="hint" role="status"></p>
        <button id="pin-use-location" class="button secondary" type="button">現在位置を入力する</button>
        <details class="coordinate-details" ${savedDemoKey(localStorage)?'':'open'}><summary>座標を直接入力する</summary><div class="coordinate-inputs"><div><label for="pin-latitude">緯度</label><input id="pin-latitude" type="number" inputmode="decimal" step="any" min="-90" max="90" required value="${html(this.draft.latitude)}"></div>
        <div><label for="pin-longitude">経度</label><input id="pin-longitude" type="number" inputmode="decimal" step="any" min="-180" max="180" required value="${html(this.draft.longitude)}"></div></div><p class="hint">地図が使えないときは緯度・経度でも登録できます。</p></details>
        <button id="pin-save" class="button" type="submit">${this.editing?'変更を保存する':'集合地点を追加する'}</button>
        <button id="pin-cancel-edit" class="button secondary" type="button" ${this.editing?'':'hidden'}>変更をやめる</button>
      </form><p class="hint">矢印と距離は直線での目安です。スマホを水平に持ってください。道路や障害物に沿った経路案内ではありません。</p></section>`;
  }
  mount(): void {
    this.mapPicker.mount(document.querySelector('#pin-map-slot'));
    document.querySelector('#pin-map-open')?.addEventListener('click',() => void this.openMap());
    document.querySelector('#pin-map-reload')?.addEventListener('click',() => window.location.reload());
    document.querySelector('#demo-key-form')?.addEventListener('submit',event => {event.preventDefault();void this.saveMapKey();});
    document.querySelector('#demo-key-remove')?.addEventListener('click',() => {
      try{localStorage.removeItem(DEMO_KEY_STORAGE);this.mapPicker.clear();this.mapSetupMessage='このブラウザーに保存したキーを削除しました。';this.redraw();}
      catch{this.mapSetupMessage='キーを削除できません。ブラウザーの保存設定を確認してください。';this.paint();}
    });
    document.querySelector('#pin-select')?.addEventListener('change',(e) => {this.selected=(e.target as HTMLSelectElement).value;this.followMain=false;this.deleting=null;this.paint();});
    document.querySelector('#pin-compass')?.addEventListener('click',() => void this.compass.start());
    document.querySelector('#pin-form')?.addEventListener('submit',e => {e.preventDefault();void this.submit();});
    document.querySelector('#pin-retry')?.addEventListener('click',() => void this.save());
    document.querySelector('#pin-main')?.addEventListener('click',() => void this.prepare('main'));
    document.querySelector('#pin-edit')?.addEventListener('click',() => {const p=this.chosen();if(!p)return;this.editing={...p};this.draft={name:p.name,latitude:String(p.latitude),longitude:String(p.longitude)};this.redraw();});
    document.querySelector('#pin-delete')?.addEventListener('click',() => {this.deleting=this.chosen();this.paint();});
    document.querySelector('#pin-delete-no')?.addEventListener('click',() => {this.deleting=null;this.paint();});
    document.querySelector('#pin-delete-yes')?.addEventListener('click',() => void this.prepare('delete',this.deleting));
    document.querySelector('#pin-cancel-edit')?.addEventListener('click',() => {this.editing=null;this.draft={name:'',latitude:'',longitude:''};this.redraw();});
    document.querySelector('#pin-use-location')?.addEventListener('click',() => {
      const s=this.source();if(s?.roomId!==this.session?.membership.roomId || !s?.self || !locationFresh(s.self,s.serverTime,s.elapsed)){this.message='新しい現在位置が必要です。位置公開をONにして更新をお待ちください。';this.paint();return;}
      this.captureDraft();this.draft.latitude=String(s.self.latitude);this.draft.longitude=String(s.self.longitude);this.redraw();
    });
    document.querySelectorAll<HTMLInputElement>('#pin-form input').forEach(input => input.addEventListener('input',() => {this.captureDraft();this.paint();}));
    this.paint();void this.sync();
  }
  private async openMap(): Promise<void> {
    const key=savedDemoKey(localStorage);
    if(!key){this.mapSetupMessage='「確認用の地図設定」でDemo Keyを保存してください。';this.paint();return;}
    await this.mapPicker.open(key);
  }
  private async saveMapKey(): Promise<void> {
    const input=document.querySelector<HTMLInputElement>('#google-demo-key');if(!input)return;
    try {
      const value=demoKey(input.value),previous=savedDemoKey(localStorage);
      localStorage.setItem(DEMO_KEY_STORAGE,value);input.value='';
      this.mapSetupMessage='Demo Keyをこのブラウザーに保存しました。';
      if(previous && previous!==value){this.mapPicker.clear();this.mapSetupMessage='Demo Keyを変更しました。画面を再読み込みしてから地図を開いてください。';this.paint();return;}
      await this.openMap();
    }catch(error){this.mapSetupMessage=error instanceof Error && error.message.startsWith('Googleで')?error.message:'キーを保存できません。ブラウザーの保存を許可してください。';this.paint();}
  }
  private draftPoint(): MapPoint | null {
    const lat=Number(this.draft.latitude),lng=Number(this.draft.longitude);
    return this.draft.latitude.trim() && this.draft.longitude.trim() && Number.isFinite(lat) && Math.abs(lat)<=90 && Number.isFinite(lng) && Math.abs(lng)<=180?{lat,lng}:null;
  }
  private chosen(): SharedPin | null {return this.pins.find(p => p.id===this.selected) ?? null;}
  private captureDraft(): void {
    const name=document.querySelector<HTMLInputElement>('#pin-name');if(!name)return;
    this.draft={name:name.value,latitude:document.querySelector<HTMLInputElement>('#pin-latitude')!.value,longitude:document.querySelector<HTMLInputElement>('#pin-longitude')!.value};
  }
  private apply(reply: PinReply): void {
    if(reply.revision! < this.revision)return;
    const previous=this.selected;this.pins=reply.pins!;this.mainId=reply.mainPinId!;this.revision=reply.revision!;this.ready=true;this.received=performance.now();
    if(this.followMain || !this.pins.some(p => p.id===this.selected)) {
      this.selected=this.mainId;
      if(previous && !this.pins.some(p => p.id===previous)){this.followMain=true;this.message='選択中の地点が削除されました。メイン集合地点へ切り替えました。';}
    }
    if(this.deleting && !this.pins.some(p => p.id===this.deleting!.id))this.deleting=null;
  }
  private terminal(reply: PinReply): boolean {
    if(['ok','conflict','pin_missing'].includes(reply.status))return false;
    this.message=reply.status==='invalid_request'?'操作を確認できませんでした。入力内容を確認してください。':statusMessages[reply.status as keyof typeof statusMessages];
    if(reply.status!=='invalid_request' && this.session){
      const status=reply.status as RoomStatus;
      acceptReply(localStorage,this.config!.url,this.session,{status});this.onTerminal?.(status);this.scopeCheck();this.redraw();
    }
    return true;
  }
  private async sync(): Promise<void> {
    this.scopeCheck();const s=this.session;if(!s || !this.config || this.reading)return;
    const generation=this.generation;this.reading=true;
    try {const reply=await pinAction(this.config,s);if(generation!==this.generation || key(s)!==key(this.current()))return;
      this.connectionError=false;if(!this.terminal(reply))this.apply(reply);
    }catch{if(generation===this.generation)this.connectionError=true;}
    finally{if(generation===this.generation)this.reading=false;this.paint();}
  }
  private async submit(): Promise<void> {
    if(this.saving || this.pending || !this.session)return;
    this.captureDraft();
    try {
      const fields=pinFields(this.draft.name,this.draft.latitude,this.draft.longitude);
      await this.persist({action:this.editing?'update':'create',requestId:crypto.randomUUID(),pinId:this.editing?.id ?? crypto.randomUUID(),version:this.editing?.version,...fields});
    }catch(error){this.message=(error as Error).message;this.paint();}
  }
  private async prepare(action: 'delete' | 'main', target=this.chosen()): Promise<void> {
    if(!target || this.saving || this.pending)return;
    try{await this.persist({action,requestId:crypto.randomUUID(),pinId:target.id,version:action==='main'?this.revision:target.version});}
    catch(error){this.message=(error as Error).message;this.paint();}
  }
  private async persist(change: PinChange): Promise<void> {
    try {localStorage.setItem(this.pendingKey(),JSON.stringify(change));}
    catch {throw new Error('操作を保存できません。ブラウザーの保存を許可してから再試行してください。');}
    this.pending=change;await this.save();
  }
  private async save(): Promise<void> {
    const s=this.session,change=this.pending;if(!s || !change || !this.config || this.saving)return;
    const generation=this.generation,storageKey=this.pendingKey();this.saving=true;this.message='集合地点の操作結果を確認しています…';this.paint();
    try {
      const reply=await pinAction(this.config,s,change);if(generation!==this.generation || key(s)!==key(this.current()))return;
      localStorage.removeItem(storageKey);this.pending=null;this.connectionError=false;
      const terminal=this.terminal(reply);
      if(!terminal)this.apply(reply);
      if(reply.status==='ok'){
        this.message=change.action==='delete'?'集合地点を削除しました。':change.action==='main'?'メイン集合地点を変更しました。':'集合地点を保存しました。';
        if(change.action==='create' && this.pins.some(p => p.id===change.pinId)){this.selected=change.pinId;this.followMain=false;}
        if(change.action==='create' || change.action==='update'){this.editing=null;this.draft={name:'',latitude:'',longitude:''};}
        this.deleting=null;
      }else if(reply.status==='conflict' || reply.status==='pin_missing')this.message='ほかの参加者が地点を変更・削除しました。「地点を変更する」で最新内容を読み直すか、「変更をやめる」を押してください。';
      this.redraw();
    }catch{if(generation===this.generation)this.message='操作結果が未確定です。「前回の操作結果を再確認する」で再試行してください。同じ地点を重複登録しません。';}
    finally{if(generation===this.generation)this.saving=false;this.paint();}
  }
  paint(): void {
    const status=document.querySelector('#pins-status');if(!status)return;
    const disabled=!this.session || !this.ready || this.saving || !!this.pending;
    text(status,!this.session?'ルームに参加すると集合地点を共有できます。':this.connectionError?'集合地点を更新できません。接続が戻り次第、再確認します。':this.message || (!this.ready?'集合地点を確認しています…':this.pins.length?'約5秒ごとに集合地点を更新しています。':'集合地点がありません。最初の地点を登録するとメインになります。'));
    const retry=document.querySelector<HTMLButtonElement>('#pin-retry')!;retry.hidden=!this.pending;retry.disabled=this.saving;
    const select=document.querySelector<HTMLSelectElement>('#pin-select')!;
    const options=this.pins.map(p => `<option value="${html(p.id)}">${html(p.name)}${p.id===this.mainId?'（メイン）':''}</option>`).join('');
    if(select.innerHTML!==options)select.innerHTML=options;
    select.value=this.selected ?? '';select.disabled=disabled || !this.pins.length;
    for(const id of ['pin-save','pin-use-location','pin-edit','pin-delete','pin-main','pin-delete-yes','pin-delete-no','pin-cancel-edit']) {
      const button=document.querySelector<HTMLButtonElement>('#'+id)!;
      button.disabled=disabled || (['pin-edit','pin-delete','pin-main'].includes(id) && !this.chosen()) || (id==='pin-main' && this.selected===this.mainId) ||
        (id==='pin-save' && !!this.editing && !this.pins.some(p => p.id===this.editing!.id && p.version===this.editing!.version));
    }
    document.querySelectorAll<HTMLInputElement>('#pin-form input').forEach(input => input.disabled=disabled);
    const mapKey=savedDemoKey(localStorage);
    text(document.querySelector('#demo-key-status')!,this.mapSetupMessage || (mapKey?'Demo Keyを登録済みです。':'Demo Keyは未設定です。'));
    text(document.querySelector('#pin-map-status')!,mapKey?this.mapPicker.message():'地図の準備が必要です。「確認用の地図設定」でDemo Keyを保存してください。座標入力も利用できます。');
    (document.querySelector('#pin-map-open') as HTMLButtonElement).disabled=disabled || !mapKey || this.mapPicker.busy();
    const reload=document.querySelector<HTMLElement>('#pin-map-reload')!;
    reload.hidden=!this.mapPicker.message().includes('再読み込み') && !this.mapSetupMessage.includes('再読み込み');
    (document.querySelector('#pin-map-slot') as HTMLElement).hidden=!this.mapPicker.available();
    const draftPoint=this.draftPoint();
    text(document.querySelector('#pin-picked-position')!,draftPoint?`仮の地点（未保存）：緯度 ${draftPoint.lat.toFixed(6)}／経度 ${draftPoint.lng.toFixed(6)}`:'まだ場所を選んでいません。地図をタップするか、現在位置を入力してください。');
    this.mapPicker.update({scope:this.scope,pins:this.pins,selected:this.selected,draft:draftPoint,enabled:!disabled});
    const confirm=document.querySelector<HTMLElement>('#pin-delete-confirm')!;confirm.hidden=!this.deleting;
    text(document.querySelector('#pin-delete-name')!,this.deleting?`「${this.deleting.name}」をルームから削除します。全員に反映されます。`:'');
    text(document.querySelector('#pin-compass-status')!,this.compass.status());
    (document.querySelector('#pin-compass') as HTMLButtonElement).disabled=this.compass.busy();
    const pin=this.chosen(),source=this.source(),heading=this.compass.heading();
    const own=source?.roomId===this.session?.membership.roomId && source && locationFresh(source.self,source.serverTime,source.elapsed)?source.self:null;
    let markup='<p class="notice">集合地点を登録・選択すると案内を表示します。</p>';
    if(pin) {
      if(!own)markup='<p class="notice">自分の新しい位置が必要です。位置公開をONにして更新をお待ちください。</p>';
      else if(performance.now()-this.received>=30000)markup='<p class="notice">集合地点の更新が止まっています。接続が戻るまで案内を隠します。</p>';
      else {
        const direction=directionTo(own,pin),angle=heading!==null && direction.bearing!==null?degrees(direction.bearing-heading):null;
        markup=`<div class="pin-destination"><h3>${html(pin.name)}${pin.id===this.mainId?' <span class="state-pill">メイン</span>':''}</h3><p class="pin-coordinates hint">緯度 ${pin.latitude}／経度 ${pin.longitude}</p>
          <p class="friend-distance">${distanceLabel(direction.distance)}</p>${angle===null?'':`<div class="pin-direction" role="img" aria-label="${html(pin.name)}の方向：画面の上から時計回りに約${Math.round(angle)%360}度"><span style="transform:rotate(${angle.toFixed(2)}deg)">↑</span></div>`}
          <p class="hint">${direction.bearing===null?'すぐ近くか、方角を確定できない地点です。':angle===null?'コンパスの方角を待っています。距離のみ表示します。':`画面の上から時計回りに約${Math.round(angle)%360}°`}</p>
          ${direction.distance<(own.accuracyMeters ?? 0)?'<p class="hint">現在位置の誤差が距離より大きい可能性があります。</p>':''}</div>`;
      }
    }
    const guide=document.querySelector('#pin-guidance')!;if(guide.innerHTML!==markup)guide.innerHTML=markup;
  }
}

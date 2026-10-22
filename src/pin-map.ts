import type { MapsSDK, MapView, MapMarker, MapPoint, MapListener, MapClick } from './google-maps';
import { loadGoogleMaps, validPoint, MAP_ERROR_EVENT } from './google-maps';
import type { SharedPin } from './pins';

export interface PinMapState {
  scope: string; pins: SharedPin[]; selected: string | null; draft: MapPoint | null; enabled: boolean;
}
export class PinMap {
  private host = document.createElement('div');
  private sdk: MapsSDK | null = null;
  private map: MapView | null = null;
  private draftMarker: MapMarker | null = null;
  private markers = new Map<string, { marker: MapMarker; listener: MapListener; signature: string }>();
  private state: PinMapState = {scope:'',pins:[],selected:null,draft:null,enabled:false};
  private loading = false;
  private attempt = 0;
  private error = '';
  private loaded = false;
  private key = '';
  private focused = '';
  private mapListener: MapListener | null = null;
  constructor(private picked: (point: MapPoint, scope: string) => void,
    private selected: (id: string, scope: string) => void, private changed: () => void,
    private loader: (key: string) => Promise<MapsSDK> = loadGoogleMaps) {
    this.host.className = 'pin-map-canvas'; this.host.setAttribute('aria-label','集合地点を選ぶGoogleマップ');
    window.addEventListener(MAP_ERROR_EVENT,(event) => {
      if (!this.map && !this.loading) return;
      this.error = (event as CustomEvent<string>).detail; this.loaded = false; this.changed();
    });
  }
  mount(slot: HTMLElement | null): void {
    if (!slot) return;
    if (this.host.parentElement !== slot) {
      slot.append(this.host);
      if (this.map && this.sdk) this.sdk.event.trigger(this.map,'resize');
    }
  }
  available(): boolean {return this.loaded && !this.error;}
  busy(): boolean {return this.loading;}
  message(): string {
    return this.error || (this.loading ? '地図を読み込んでいます…' : this.loaded ? '地図をタップして仮のピンを置き、地点名を入力して登録してください。仮のピンはドラッグでも調整できます。' : '「地図を開く」でGoogleマップから場所を選べます。');
  }
  private point(event: MapClick, fallback?: MapPoint | null): void {
    const point = event.latLng ? {lat:event.latLng.lat(),lng:event.latLng.lng()} : fallback;
    if (!this.state.enabled || !this.available() || !point || !validPoint(point)) return;
    event.stop?.(); this.picked(point,this.state.scope);
  }
  async open(key: string): Promise<void> {
    if (this.loading) return;
    if(this.map && this.error){this.error='地図を再開するには画面を再読み込みしてください。';this.changed();return;}
    if (this.map && key === this.key && !this.error) {this.loaded = true;this.changed();return;}
    this.loading = true;this.error = ''; const attempt=++this.attempt;this.changed();
    try {
      const sdk = await this.loader(key);if(attempt!==this.attempt)return;
      if(!this.map) {
        this.sdk = sdk;this.key = key;
        const pin=this.state.pins.find(p=>p.id===this.state.selected);
        const center=this.state.draft ?? (pin?{lat:pin.latitude,lng:pin.longitude}:{lat:35.681236,lng:139.767125});
        this.map = new sdk.Map(this.host,{center,zoom:15,mapId:'DEMO_MAP_ID',mapTypeControl:false,streetViewControl:false,
          fullscreenControl:true,gestureHandling:'cooperative',clickableIcons:false,keyboardShortcuts:true});
        this.mapListener = this.map.addListener('click',event => this.point(event));
        this.draftMarker = new sdk.marker.AdvancedMarkerElement({map:null,title:'仮のピン（未登録）',gmpDraggable:true});
        const label=document.createElement('span');label.className='draft-map-pin';label.textContent='仮';this.draftMarker.append(label);
        this.draftMarker.addListener('dragend',event => this.point(event,this.draftMarker?.position));
      } else if (key !== this.key) throw new Error('地図のキーを変更しました。画面を再読み込みしてください。');
      this.loaded = true;this.update(this.state);
    } catch (error) {if(attempt===this.attempt)this.error=(error as Error).message;}
    finally {if(attempt===this.attempt){this.loading=false;this.changed();if(this.map && this.loaded)this.sdk?.event.trigger(this.map,'resize');}}
  }
  clear(): void {
    this.attempt++;this.loading=false;this.loaded=false;this.error='';this.key='';this.focused='';
    for(const record of this.markers.values()){record.listener.remove();record.marker.map=null;}
    this.markers.clear();this.mapListener?.remove();
    if(this.draftMarker){this.draftMarker.map=null;this.sdk?.event.clearInstanceListeners(this.draftMarker);}
    if(this.map)this.sdk?.event.clearInstanceListeners(this.map);
    this.map=null;this.sdk=null;this.draftMarker=null;this.host.replaceChildren();this.changed();
  }
  update(state: PinMapState): void {
    const former=this.state.scope;this.state=state;
    if(former!==state.scope && this.loading){this.attempt++;this.loading=false;}
    if(!this.map || !this.sdk)return;
    if(former!==state.scope){this.focused='';this.map.panTo({lat:35.681236,lng:139.767125});}
    const visible=new Set(state.pins.map(p=>p.id));
    for(const [id,record]of this.markers){if(!visible.has(id)){record.listener.remove();record.marker.map=null;this.markers.delete(id);}}
    for(const pin of state.pins){
      let record=this.markers.get(pin.id);const signature=JSON.stringify([pin.name,pin.latitude,pin.longitude,pin.id===state.selected]);
      if(!record){
        const marker=new this.sdk.marker.AdvancedMarkerElement({map:this.map,position:{lat:pin.latitude,lng:pin.longitude},title:pin.name});
        const listener=marker.addListener('click',() => {if(this.state.scope===state.scope && this.state.enabled)this.selected(pin.id,state.scope);});
        record={marker,listener,signature:''};this.markers.set(pin.id,record);
      }
      if(record.signature!==signature){record.marker.position={lat:pin.latitude,lng:pin.longitude};record.marker.title=(pin.id===state.selected?'案内中：':'集合地点：')+pin.name;record.signature=signature;}
    }
    if(this.draftMarker){this.draftMarker.position=state.draft;this.draftMarker.map=state.draft && state.enabled && this.available()?this.map:null;}
    const target=state.draft ?? (()=>{const p=state.pins.find(p=>p.id===state.selected);return p?{lat:p.latitude,lng:p.longitude}:null;})();
    const signature=JSON.stringify([state.scope,target]);
    if(target && signature!==this.focused){this.focused=signature;this.map.panTo(target);}
  }
}

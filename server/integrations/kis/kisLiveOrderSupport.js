export class KisLiveOrderServiceError extends Error{constructor(message,{code="KIS_LIVE_ORDER_SERVICE_ERROR",statusCode=500,ambiguous=false,}={}){super(message);this.name="KisLiveOrderServiceError";this.code=code;this.statusCode=statusCode;this.ambiguous=ambiguous;}}export function replayExisting(state){if(state.state==="PENDING"){return unknownResponse(state,{code:"KIS_LIVE_COMMAND_PENDING",message:"동일 clientOrderId 주문이 처리 중입니다.",},true);}const result=structuredClone(state.result??unknownResponse(state,state.error,false));result.replayed=true;return result;}export function unknownResponse(command,error,replayed){return{clientOrderId:command.clientOrderId,operation:command.operation,status:"UNKNOWN_RESULT",replayed,error:safeError(error),};}export function normalizeClientOrderId(value){const id=String(value??"").trim();if(!/^[A-Za-z0-9._:-]{1,80}$/.test(id)){throw new KisLiveOrderServiceError("clientOrderId는 1~80자의 영문, 숫자, 점, 밑줄, 콜론, 하이픈만 사용할 수 있습니다.",{code:"KIS_LIVE_CLIENT_ORDER_ID_INVALID",statusCode:400},);}return id;}export function normalizeSubmitRequest(input){return{side:String(input?.side??"").trim().toUpperCase(),symbol:String(input?.symbol??"").trim().toUpperCase(),type:String(input?.type??"MARKET").trim().toUpperCase(),quantity:Number(input?.quantity),limitPrice:input?.limitPrice===undefined?null:Number(input.limitPrice),referencePrice:input?.referencePrice===undefined?null:Number(input.referencePrice),exchange:String(input?.exchange??"KRX").trim().toUpperCase(),};}export function normalizeReviseCancelRequest(input,operation){const type=input?.type===undefined||input?.type===null||String(input.type).trim()===""?(operation==="REVISE"?"LIMIT":null):String(input.type).trim().toUpperCase();return{operation,originalOrderNumber:String(input?.originalOrderNumber??"").trim(),orderOrganizationNumber:String(input?.orderOrganizationNumber??"").trim(),type,quantity:Number(input?.quantity),limitPrice:input?.limitPrice===undefined?null:Number(input.limitPrice),referencePrice:input?.referencePrice===undefined?null:Number(input.referencePrice),exchange:String(input?.exchange??"KRX").trim().toUpperCase(),allQuantity:input?.allQuantity!==false,};}export function safeRequest(request){return structuredClone(request);}export function safeError(error){if(!error)return{code:"UNKNOWN",message:"알 수 없는 오류"};if(typeof error==="object"&&!(error instanceof Error)&&error.code&&error.message){return{code:String(error.code),message:String(error.message)};}return{code:String(error?.code??"KIS_LIVE_ERROR"),message:error instanceof Error?error.message:String(error),};}export function koreaDateKey(timestamp){return new Date(Number(timestamp)+9*60*60*1_000).toISOString().slice(0,10);}export function finiteNumberOrNull(value){const number=Number(value);return Number.isFinite(number)?number:null;}

export function normalizeOrderBookSnapshot(input) {
  if (!input || typeof input !== "object") return null;
  const bids = normalizeBookLevels(input.bids);
  const asks = normalizeBookLevels(input.asks);
  if (bids.length === 0 && asks.length === 0) return null;
  const tickSize = Number(input.tickSize);
  const referencePrice = Number(input.referencePrice);
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;
  return {
    capturedAt: Number.isFinite(Number(input.capturedAt)) ? Number(input.capturedAt) : null,
    tickSize,
    referencePrice,
    bids,
    asks,
  };
}

function normalizeBookLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => ({ price: Number(level?.price), size: Number(level?.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .slice(0, 10);
}

import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';

/**
 * N12 / **R244**：**网关自身**的 404 ⇒ §11.1 的统一信封。
 *
 * ─── 为什么是 `10001` ───────────────────────────────────────────────
 * §11.2 的码表是**封闭**的（`errors.test.ts` 的 `SPEC_CODES` 机械校验），里面没有
 * 「路由不存在」这个语义的专用码。表内最贴近的一支是 `10001 BAD_PARAM`：一个不存在的
 * 路径**就是**一个非法的请求目标。新增错误码违反 Global Constraint 7 与 §11.2 的封闭性。
 *
 * ─── 为什么**只**拦 `NotFoundException` ────────────────────────────
 * 401/403/429/503 的信封是**故意**用不同状态码区分的（`slice-07.2-*` 有一大批断言钉住它们），
 * 顺手统一会把那一批全部打红。而 404 有两类，必须区别对待：
 *  - **路由不存在**（Nest 路由层抛 `NotFoundException`，响应体是 `{statusCode,message,error}`）
 *    ⇒ 本过滤器渲染成 `{code:10001,...}`；
 *  - **业务 404**（如 `12001 房间不存在`）：网关是**反向代理**，下游的 404 由
 *    `ProxyGateway.forward()` 直接 `res.status(...).json(body)` 写出 —— **没有异常**，
 *    因此本过滤器**碰不到**它。另外，若某个控制器自己抛了**带信封**的 `NotFoundException`
 *    （响应体里已有数字 `code`），本过滤器也**原样放行**（见下），绝不改写成 `10001`。
 *
 * ─── 为什么必须处理 `res.headersSent` ───────────────────────────────
 * 响应已经写出去（代理写完 404 后又有人抛异常）时再写一次会抛
 * `ERR_HTTP_HEADERS_SENT` —— 那个异常会盖掉真正的错误。Nest 默认处理器的做法是
 * 「已发出 ⇒ `end()`」，这里**逐字复刻**（不继承 `BaseExceptionFilter`：
 * 它需要注入 `HttpAdapterHost`，而全局过滤器实例经 `useGlobalFilters(new ...)` 注册时
 * 拿不到 DI，`applicationRef` 会是 undefined）。
 */
@Catch(NotFoundException)
export class NotFoundEnvelopeFilter implements ExceptionFilter<NotFoundException> {
  private readonly logger = new Logger(NotFoundEnvelopeFilter.name);

  catch(exception: NotFoundException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
      end: () => void;
      headersSent?: boolean;
      statusCode?: number;
    }>();

    // 响应已经写过 ⇒ 绝不再写（Nest 默认处理器同样是「end 掉」）
    if (res.headersSent) {
      this.logger.warn('404 envelope skipped: response headers already sent');
      res.end();
      return;
    }

    const body = exception.getResponse();

    // 已经是 §11.1 信封（带数字 code）的业务 404 ⇒ 原样放行，**不得**改写成 10001
    // （R244：`12001 房间不存在` 与「路径不存在」是两件事）。
    if (typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'number') {
      const status = exception.getStatus();
      this.logger.debug(`Passing through business 404 (code=${(body as { code: number }).code})`);
      res.status(status).json(body);
      return;
    }

    const message =
      typeof body === 'string'
        ? body
        : typeof (body as { message?: unknown })?.message === 'string'
          ? ((body as { message: string }).message)
          : exception.message;

    res.status(exception.getStatus() ?? HttpStatus.NOT_FOUND).json({
      code: ErrCode.BAD_PARAM,
      message,
      data: null,
    });
  }
}

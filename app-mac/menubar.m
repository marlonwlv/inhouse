// Launcher de menu bar do Inhouse (macOS) — Objective-C/AppKit.
//
// O .app carrega dentro de Resources/ o servidor compilado (srv/) e um runtime
// Node completo (node/ — inclui npm/corepack, para máquinas sem Node). Este
// launcher: sobe o servidor, espera ficar saudável, abre o navegador e dá
// controle pela barra de menu (abrir / registro / reiniciar / encerrar).
// Se já houver um Inhouse no ar (ex.: `npm start` do desenvolvedor), o app
// NÃO sobe um segundo servidor — só abre o navegador no que existe.
//
// Em ObjC (clang) de propósito: compila com as Command Line Tools em qualquer
// Mac, sem depender do toolchain Swift casar com o SDK.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static const NSInteger PORTA_BASE = 4400;
static const NSInteger PORTAS_TENTATIVAS = 10;

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property(strong) NSStatusItem *statusItem;
@property(strong) NSTask *servidor;
@property(strong) NSFileHandle *logHandle;
@property(assign) NSInteger porta;
@property(assign) BOOL reusandoServidorExistente;
@property(assign) BOOL encerrando;
@property(strong) NSMenuItem *itemStatus;
@property(strong) NSMenuItem *itemReiniciar;
@end

@implementation AppDelegate

// ---------- caminhos do bundle ----------

- (NSString *)resources { return NSBundle.mainBundle.resourcePath; }
- (NSString *)nodeBin { return [self.resources stringByAppendingPathComponent:@"node/bin/node"]; }
- (NSString *)nodeBinDir { return [self.resources stringByAppendingPathComponent:@"node/bin"]; }
- (NSString *)servidorJs { return [self.resources stringByAppendingPathComponent:@"srv/server/index.js"]; }
- (NSString *)logPath {
  return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/Inhouse.log"];
}

// ---------- ciclo de vida ----------

- (void)applicationDidFinishLaunching:(NSNotification *)note {
  self.porta = PORTA_BASE;
  self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
  NSImage *icone = [NSImage imageWithSystemSymbolName:@"shippingbox"
                             accessibilityDescription:@"Inhouse"];
  if (icone) {
    icone.template = YES;
    self.statusItem.button.image = icone;
  } else {
    self.statusItem.button.title = @"In";
  }

  NSMenu *menu = [NSMenu new];
  self.itemStatus = [[NSMenuItem alloc] initWithTitle:@"Iniciando…" action:nil keyEquivalent:@""];
  self.itemStatus.enabled = NO;
  [menu addItem:self.itemStatus];
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItem:[self item:@"Abrir o Inhouse" acao:@selector(abrirNavegador) tecla:@"o"]];
  [menu addItem:[self item:@"Ver o registro" acao:@selector(abrirRegistro) tecla:@""]];
  self.itemReiniciar = [self item:@"Reiniciar o servidor" acao:@selector(reiniciarServidor) tecla:@""];
  self.itemReiniciar.hidden = YES;
  [menu addItem:self.itemReiniciar];
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItem:[self item:@"Encerrar o Inhouse" acao:@selector(encerrar) tecla:@"q"]];
  menu.autoenablesItems = NO;
  self.statusItem.menu = menu;

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [self subirOuReusar];
  });
}

- (NSMenuItem *)item:(NSString *)titulo acao:(SEL)acao tecla:(NSString *)tecla {
  NSMenuItem *i = [[NSMenuItem alloc] initWithTitle:titulo action:acao keyEquivalent:tecla];
  i.target = self;
  return i;
}

- (void)applicationWillTerminate:(NSNotification *)note {
  self.encerrando = YES;
  [self pararServidor];
}

// ---------- servidor ----------

/// Procura um Inhouse já no ar nas portas da faixa; senão sobe o embutido
/// na primeira porta livre.
- (void)subirOuReusar {
  for (NSInteger p = PORTA_BASE; p < PORTA_BASE + PORTAS_TENTATIVAS; p++) {
    if ([self ehInhouseNaPorta:p]) {
      self.porta = p;
      self.reusandoServidorExistente = YES;
      dispatch_async(dispatch_get_main_queue(), ^{
        [self marcarNoAr:[NSString stringWithFormat:@"usando o Inhouse já aberto na porta %ld", (long)p]];
        [self abrirNavegador];
      });
      return;
    }
  }
  NSInteger p = PORTA_BASE;
  while (p < PORTA_BASE + PORTAS_TENTATIVAS && [self portaOcupada:p]) p++;
  self.porta = p;
  [self iniciarServidor];
}

- (void)iniciarServidor {
  NSFileManager *fm = NSFileManager.defaultManager;
  if (![fm isExecutableFileAtPath:self.nodeBin]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self marcarFalha:@"runtime não encontrado no app"];
    });
    return;
  }
  [fm createFileAtPath:self.logPath contents:nil attributes:nil];
  self.logHandle = [NSFileHandle fileHandleForWritingAtPath:self.logPath];
  [self.logHandle seekToEndOfFile];

  NSTask *proc = [NSTask new];
  proc.executableURL = [NSURL fileURLWithPath:self.nodeBin];
  proc.arguments = @[ self.servidorJs ];

  // PATH rico: node embutido primeiro (npm/corepack garantidos), depois os
  // locais comuns — lançado pelo Finder, o PATH padrão é mínimo e o servidor
  // não acharia claude/git/npm.
  NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
  NSString *pathBase = env[@"PATH"] ?: @"/usr/bin:/bin:/usr/sbin:/sbin";
  env[@"PATH"] = [NSString stringWithFormat:@"%@:%@/.local/bin:/opt/homebrew/bin:/usr/local/bin:%@",
                                            self.nodeBinDir, NSHomeDirectory(), pathBase];
  env[@"INHOUSE_PORT"] = [NSString stringWithFormat:@"%ld", (long)self.porta];
  proc.environment = env;
  if (self.logHandle) {
    proc.standardOutput = self.logHandle;
    proc.standardError = self.logHandle;
  }

  __weak typeof(self) fraco = self;
  proc.terminationHandler = ^(NSTask *t) {
    typeof(self) forte = fraco;
    if (!forte || forte.encerrando) return;
    dispatch_async(dispatch_get_main_queue(), ^{
      [forte marcarFalha:[NSString stringWithFormat:@"o servidor parou (código %d)", t.terminationStatus]];
    });
  };

  NSError *erro = nil;
  if (![proc launchAndReturnError:&erro]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self marcarFalha:@"não foi possível iniciar o servidor"];
    });
    return;
  }
  self.servidor = proc;
  dispatch_async(dispatch_get_main_queue(), ^{
    self.itemStatus.title = [NSString stringWithFormat:@"Iniciando na porta %ld…", (long)self.porta];
  });
  [self esperarSaudavel];
}

- (void)esperarSaudavel {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
    for (int i = 0; i < 60; i++) {
      if (self.encerrando) return;
      if ([self ehInhouseNaPorta:self.porta]) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [self marcarNoAr:[NSString stringWithFormat:@"rodando na porta %ld", (long)self.porta]];
          [self abrirNavegador];
        });
        return;
      }
      usleep(500000);
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [self marcarFalha:@"o servidor não respondeu a tempo"];
    });
  });
}

- (void)pararServidor {
  NSTask *proc = self.servidor;
  if (!proc || !proc.running) return;
  [proc terminate]; // SIGTERM: o servidor derruba previews e fases com limpeza
  [proc waitUntilExit];
  self.servidor = nil;
}

// ---------- estado no menu ----------

- (void)marcarNoAr:(NSString *)detalhe {
  self.itemStatus.title = [NSString stringWithFormat:@"No ar — %@", detalhe];
  self.itemReiniciar.hidden = self.reusandoServidorExistente;
}

- (void)marcarFalha:(NSString *)motivo {
  self.itemStatus.title = [NSString stringWithFormat:@"Parado — %@", motivo];
  self.itemReiniciar.hidden = NO;
}

// ---------- ações do menu ----------

- (void)abrirNavegador {
  NSString *url = [NSString stringWithFormat:@"http://localhost:%ld", (long)self.porta];
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:url]];
}

- (void)abrirRegistro {
  [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:self.logPath]];
}

- (void)reiniciarServidor {
  self.itemStatus.title = @"Reiniciando…";
  self.itemReiniciar.hidden = YES;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [self pararServidor];
    sleep(1);
    self.reusandoServidorExistente = NO;
    [self subirOuReusar];
  });
}

- (void)encerrar {
  [NSApp terminate:nil];
}

// ---------- sondas ----------

/// A porta responde como um Inhouse? (GET /api/state com JSON contendo "claude")
- (BOOL)ehInhouseNaPorta:(NSInteger)porta {
  NSString *u = [NSString stringWithFormat:@"http://127.0.0.1:%ld/api/state", (long)porta];
  NSMutableURLRequest *pedido = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:u]];
  pedido.timeoutInterval = 2;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block BOOL achou = NO;
  [[NSURLSession.sharedSession dataTaskWithRequest:pedido
                                 completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)resp;
    if ([http isKindOfClass:NSHTTPURLResponse.class] && http.statusCode == 200 && data) {
      NSString *corpo = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
      if ([corpo containsString:@"\"claude\""]) achou = YES;
    }
    dispatch_semaphore_signal(sem);
  }] resume];
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
  return achou;
}

/// Alguém (não-Inhouse) já escuta nesta porta? (conexão aceita = ocupada)
- (BOOL)portaOcupada:(NSInteger)porta {
  NSString *u = [NSString stringWithFormat:@"http://127.0.0.1:%ld/", (long)porta];
  NSMutableURLRequest *pedido = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:u]];
  pedido.timeoutInterval = 1;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block BOOL ocupada = NO;
  [[NSURLSession.sharedSession dataTaskWithRequest:pedido
                                 completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
    if (resp != nil) {
      ocupada = YES;
    } else if (err && err.code != NSURLErrorCannotConnectToHost) {
      ocupada = YES; // erro diferente de "conexão recusada": não arrisca a porta
    }
    dispatch_semaphore_signal(sem);
  }] resume];
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  return ocupada;
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    AppDelegate *delegate = [AppDelegate new];
    app.delegate = delegate;
    // Menu bar apenas (reforça o LSUIElement do Info.plist).
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [app run];
  }
  return 0;
}

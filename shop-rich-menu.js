function mountShopRichMenu(shop, request, canEditLiff = false) {
  const section = document.getElementById('shop-rich-menu');
  const field = id => section.querySelector('#rich-' + id);
  section.dataset.shop = shop.shop_id;
  const preview = field('preview');
  const canvas = field('areas');
  const fileControl = field('file');
  const status = field('status');
  const actionNames = ['สั่งอาหาร', 'จองโต๊ะ / ที่นั่ง', 'เข้าเล่นกุ้ง'];
  const format = heights => heights === 843 || heights === 1686;
  let image = null;
  let areas = [];
  let drag = null;
  let shopRequest = 0;
  const call = (operation, details = {}) =>
    request('platform_rich_menu', { target_shop_id: shop.shop_id, operation, ...details });
  const messages = {
    RICH_MENU_INVALID: 'ตรวจสอบภาพและลิงก์สั่งอาหาร รวมถึงกรอบพื้นที่กด',
    RICH_MENU_OA_REQUIRED: 'เชื่อม LINE OA เฉพาะของร้านก่อนเผยแพร่',
    RICH_MENU_LINE_FAILED: 'LINE ยังรับเมนูไม่ได้ กรุณาตรวจสอบการเชื่อมต่อ OA และลองใหม่',
    RICH_MENU_PILOT_ONLY: 'ร้านนี้บันทึกฉบับร่างได้ การเผยแพร่เปิดเฉพาะร้านนำร่องในช่วงทดสอบ',
    RICH_MENU_BUSY: 'กำลังเผยแพร่เมนูของร้าน กรุณารอสักครู่แล้วเปิดใหม่',
  };

  function render() {
    canvas.replaceChildren();
    if (!image) return;
    for (const [i, rect] of areas.entries()) {
      const area = document.createElement('span');
      area.className = 'rich-area rich-area-' + i;
      area.textContent = areas.length === 2 && i === 1 ? actionNames[2] : actionNames[i];
      Object.assign(area.style, {
        left: (100 * rect.x / 2500) + '%',
        top: (100 * rect.y / image.height) + '%',
        width: (100 * rect.width / 2500) + '%',
        height: (100 * rect.height / image.height) + '%',
      });
      canvas.append(area);
    }
  }

  function resetAreas() {
    if (!image) return;
    areas = [0, 833, 1667].map((x, i) => ({
      x, y: 0, width: [833, 834, 833][i], height: image.height,
    }));
    field('action').querySelector('option[value="1"]').textContent = actionNames[1];
    field('action').querySelector('option[value="2"]').hidden = false;
    render();
  }

  function showImage() {
    field('workspace').hidden = !image;
    preview.src = image ? 'data:' + image.mime + ';base64,' + image.data : '';
    canvas.style.aspectRatio = image ? '2500 / ' + image.height : '';
    render();
  }

  function coordinates(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.min(2500, Math.max(0, Math.round((event.clientX - bounds.left) * 2500 / bounds.width))),
      y: Math.min(image.height, Math.max(0, Math.round((event.clientY - bounds.top) * image.height / bounds.height))),
    };
  }

  canvas.onpointerdown = event => {
    if (!image || drag || !event.isPrimary || event.button !== 0) return;
    const selected = Number(field('action').value);
    if (!areas[selected]) return;
    drag = { id: event.pointerId, start: coordinates(event), selected, previous: areas[selected] };
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (drag?.id !== event.pointerId) return;
    const end = coordinates(event);
    areas[drag.selected] = {
      x: Math.min(drag.start.x, end.x), y: Math.min(drag.start.y, end.y),
      width: Math.abs(drag.start.x - end.x), height: Math.abs(drag.start.y - end.y),
    };
    render();
  };
  const endDrag = (event, cancelled) => {
    if (drag?.id !== event.pointerId) return;
    const area = areas[drag.selected];
    if (cancelled || area.width < 20 || area.height < 20) areas[drag.selected] = drag.previous;
    drag = null;
    render();
  };
  canvas.onpointerup = event => {
    canvas.onpointermove(event);
    endDrag(event, false);
  };
  canvas.onpointercancel = event => endDrag(event, true);
  canvas.onlostpointercapture = event => endDrag(event, true);
  field('reset').onclick = resetAreas;

  async function readImage(file) {
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 1000000) throw Error();
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    bitmap.close();
    if (width !== 2500 || !format(height)) throw Error();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { mime: file.type, data, height };
  }

  fileControl.onchange = async () => {
    const file = fileControl.files[0];
    if (!file) return;
    const version = ++shopRequest;
    try {
      const uploaded = await readImage(file);
      if (version !== shopRequest) return;
      image = uploaded;
      resetAreas();
      showImage();
      status.textContent = '';
    } catch {
      if (version !== shopRequest) return;
      status.textContent = 'เลือก PNG หรือ JPEG ขนาด 2500 × 843 หรือ 2500 × 1686 พิกเซล ไม่เกิน 1 MB';
    } finally {
      if (version === shopRequest) fileControl.value = '';
    }
  };

  field('default').onclick = async () => {
    const version = ++shopRequest;
    try {
      const result = await fetch('./assets/rich-menu-standard-2500x843.jpg');
      if (!result.ok) throw Error();
      const standard = await readImage(await result.blob());
      if (version !== shopRequest) return;
      image = standard;
      resetAreas();
      showImage();
      status.textContent = 'เลือกภาพมาตรฐานแล้ว';
    } catch {
      if (version === shopRequest) status.textContent = 'โหลดภาพมาตรฐานไม่สำเร็จ';
    }
  };

  const activeShop = () => section.dataset.shop === shop.shop_id;
  field('player').href = playerEntryUrl(shop.shop_id);
  if (!canEditLiff) void configuredPlayerEntryUrl(shop.shop_id).then(url => {
    if (activeShop()) field('player').href = url;
  });
  const liffField = field('liff');
  const liffSave = field('liff-save');
  const liffStatus = field('liff-status');
  const liffPreview = field('liff-preview');
  field('liff-settings').hidden = !canEditLiff;
  if (canEditLiff) {
    const liffRequest = (operation, details = {}) => request('platform_player_liff', {
      operation, target_shop_id: shop.shop_id, ...details
    });
    const liffId = () => /^(?:https:\/\/liff\.line\.me\/)?([0-9]{1,20}-[A-Za-z0-9]{1,80})\/?$/
      .exec(liffField.value.trim())?.[1];
    const renderLiff = result => {
      liffField.value = result.liff_id ? 'https://liff.line.me/' + result.liff_id : '';
      field('player').href = result.player_url;
      liffField.oninput();
    };
    liffField.oninput = () => {
      const id = liffId();
      liffPreview.hidden = !id;
      if (id) {
        const url = new URL(playerEntryUrl(shop.shop_id, {}, id));
        url.searchParams.set('shop_liff_preview', id);
        liffPreview.href = url.href;
      }
    };
    liffField.value = '';
    liffField.oninput();
    liffField.disabled = liffSave.disabled = true;
    liffStatus.textContent = 'กำลังโหลดค่า LIFF…';
    liffRequest('read').then(result => {
      if (!activeShop()) return;
      renderLiff(result);
      liffField.disabled = liffSave.disabled = false;
      liffStatus.textContent = '';
    }).catch(() => {
      if (activeShop()) liffStatus.textContent = 'โหลดค่า LIFF ไม่สำเร็จ กรุณาเปิดหน้านี้ใหม่';
    });
    liffSave.onclick = async () => {
      const value = liffField.value.trim();
      if (value && !liffId()) {
        liffStatus.textContent = 'กรอก LIFF ID หรือลิงก์ https://liff.line.me/ ของร้าน';
        return;
      }
      liffField.disabled = liffSave.disabled = true;
      try {
        const result = await liffRequest('save', { liff_url: value });
        if (!activeShop()) return;
        renderLiff(result);
        liffStatus.textContent = 'บันทึกแล้ว · หากต้องการเปลี่ยนปุ่มใน LINE ให้เผยแพร่ริชเมนูสมาชิกอีกครั้ง';
      } catch (error) {
        if (!activeShop()) return;
        const errors = {
          SHOP_OA_NOT_CONFIGURED: 'เชื่อม LINE OA ของร้านก่อนเปิดใช้ LIFF',
          SHOP_LIFF_CHANNEL_IN_USE: 'LINE Login Channel นี้ถูกใช้กับร้านอื่นแล้ว',
          SHOP_LIFF_PLATFORM_CHANNEL: 'ใช้ LINE Login Channel ของร้านนี้',
        };
        liffStatus.textContent = errors[error.message] || 'บันทึก LIFF ไม่สำเร็จ กรุณาลองใหม่';
      } finally {
        if (activeShop()) liffField.disabled = liffSave.disabled = false;
      }
    };
  }
  for (const key of ['food', 'booking']) {
    field(key).oninput = () => {
      try {
        const url = new URL(field(key).value);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          field(key + '-test').href = url.href;
          field(key + '-test').hidden = false;
          return;
        }
      } catch { /* Await a complete URL. */ }
      field(key + '-test').hidden = true;
    };
  }

  const buttons = [field('save'), field('publish')];
  async function submit(operation) {
    if (!image || !field('food').reportValidity() || !field('booking').reportValidity() ||
        buttons.some(button => button.disabled)) return;
    const overlap = areas.some((a, i) => areas.slice(i + 1).some(b =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
    if (overlap) {
      status.textContent = 'กรอบพื้นที่กดซ้อนกัน กรุณาปรับให้แยกกัน';
      return;
    }
    if (operation === 'publish' && !confirm('เผยแพร่ริชเมนูสมาชิกของ ' + shop.shop_name + '?')) return;
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = 'กำลังบันทึก…';
    try {
      await call(operation, { draft: { ...image, areas, food_url: field('food').value.trim(), booking_url: field('booking').value.trim() } });
      status.textContent = operation === 'save' ? 'บันทึกฉบับร่างแล้ว' : 'เผยแพร่เมนูแล้ว ระบบกำลังซิงก์ให้สมาชิก';
    } catch (error) {
      status.textContent = messages[error.message] || 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  field('save').onclick = () => void submit('save');
  field('publish').onclick = () => void submit('publish');
  section.hidden = false;
  buttons.forEach(button => { button.disabled = true; });
  const version = shopRequest;
  void call('load').then(({ draft, published }) => {
    if (version !== shopRequest) return;
    if (draft) {
      image = draft;
      areas = draft.areas;
      field('food').value = draft.food_url;
      field('food').oninput();
      field('booking').value = draft.booking_url || '';
      field('booking').oninput();
      if (areas.length === 2) {
        field('action').querySelector('option[value="1"]').textContent = actionNames[2];
        field('action').querySelector('option[value="2"]').hidden = true;
      }
      showImage();
    } else {
      void field('default').onclick();
    }
    status.textContent = published ? 'ร้านนี้มีริชเมนูสมาชิกที่เผยแพร่แล้ว' : '';
  }).catch(error => {
    if (version === shopRequest) status.textContent = messages[error.message] || 'โหลดการตั้งค่าไม่สำเร็จ';
  }).finally(() => buttons.forEach(button => { button.disabled = false; }));
}

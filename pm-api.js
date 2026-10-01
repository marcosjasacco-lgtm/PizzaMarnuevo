(function () {
  "use strict";

  const RPC = {
    storefront: [],
    settings: [],
    catalog: ["pm_catalog"],
    create: ["pm_create_order"],
    publicOrder: ["pm_track_order"],
    staffOrders: ["pm_staff_orders"],
    accept: ["pm_accept_order"],
    reject: ["pm_reject_order"],
    ready: ["pm_ready_order"],
    transition: ["pm_transition"]
  };

  const signatureError = (error) => {
    const code = String(error?.code || "");
    const message = String(error?.message || error || "").toLowerCase();
    return code === "PGRST202" || code === "42883" || /could not find the function|does not exist|no function|schema cache|unknown argument|parameters/.test(message);
  };

  const parseMaybeJson = (value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch (_) { return value; }
  };

  const firstObject = (value) => {
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) return parsed[0] || null;
    if (parsed && typeof parsed === "object") {
      if (parsed.result !== undefined) return firstObject(parsed.result);
      if (parsed.data !== undefined && !parsed.id && !parsed.order_id) return firstObject(parsed.data);
    }
    return parsed || null;
  };

  const rowsFrom = (value) => {
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      for (const key of ["orders", "data", "items", "results"]) {
        if (Array.isArray(parsed[key])) return parsed[key];
      }
      if (parsed.order || parsed.id || parsed.order_id) return [parsed.order || parsed];
    }
    return [];
  };

  const readItems = (row) => {
    const raw = row?.items ?? row?.order_items ?? row?.lines ?? row?.items_json ?? row?.products ?? [];
    const parsed = parseMaybeJson(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      id: item.id ?? item.product_id ?? null,
      name: item.name ?? item.product_name ?? item.title ?? "Producto",
      price: Number(item.price ?? item.unit_price ?? item.amount ?? 0),
      quantity: Number(item.quantity ?? item.qty ?? item.cantidad ?? 1),
      category: item.category ?? item.categoria ?? null,
      notes: item.notes ?? item.note ?? ""
    }));
  };

  const normalizeOrder = (input) => {
    const row = firstObject(input) || {};
    const source = row.order && typeof row.order === "object" ? { ...row, ...row.order } : row;
    return {
      ...source,
      id: source.id ?? source.order_id ?? source.pm_order_id,
      public_token: source.public_token ?? source.client_token ?? source.access_token ?? source.order_token ?? null,
      status: String(source.status ?? "pending").toLowerCase(),
      customer_name: source.customer_name ?? source.name ?? source.customer?.name ?? "Sin nombre",
      customer_phone: source.customer_phone ?? source.phone ?? source.customer?.phone ?? "",
      address: source.address ?? source.delivery_address ?? source.customer_address ?? source.customer?.address ?? "",
      cross_streets: source.cross_streets ?? source.cross ?? source.between_streets ?? source.customer?.cross ?? "",
      neighborhood: source.neighborhood ?? source.barrio ?? source.customer?.neighborhood ?? "",
      fulfillment: source.fulfillment ?? source.fulfillment_type ?? source.delivery_type ?? "delivery",
      payment_method: source.payment_method ?? source.payment ?? "cash",
      subtotal: Number(source.subtotal ?? 0),
      discount: Number(source.discount ?? source.discount_amount ?? 0),
      shipping: Number(source.shipping ?? source.shipping_cost ?? 0),
      total: Number(source.total ?? 0),
      created_at: source.created_at ?? source.createdAt ?? new Date().toISOString(),
      items: readItems(source)
    };
  };

  const normalizeSettings = (input) => {
    const row = firstObject(input) || {};
    const source = row.settings && typeof row.settings === "object" ? { ...row, ...row.settings } : row;
    const accepting = source.accepting_orders ?? source.accepting ?? source.open ?? false;
    return {
      accepting_orders: accepting === true || accepting === 1 || String(accepting).toLowerCase() === "true",
      discount_percent: Number(source.discount_percent ?? source.discount ?? 15),
      shipping_near: Number(source.shipping_near ?? source.shipping_near_amount ?? 500),
      shipping_far: Number(source.shipping_far ?? source.shipping_far_amount ?? 1500)
    };
  };

  const normalizeCatalog = (input) => {
    const rows = rowsFrom(input);
    return rows.map((row) => ({
      id: row.id ?? row.product_id ?? null,
      name: row.name ?? row.product_name ?? row.title ?? "",
      price: Number(row.price ?? 0),
      category: row.category ?? row.categoria ?? "Otros",
      active: row.active !== false,
      image: row.image ?? row.image_url ?? null
    })).filter((row) => row.name);
  };

  const rpcVariants = async (db, names, variants) => {
    let last = { data: null, error: { message: "No se encontró la función del backend." } };
    for (const name of names) {
      for (const args of variants) {
        const response = await db.rpc(name, args);
        if (!response.error) return { ...response, functionName: name };
        last = { ...response, functionName: name };
        if (!signatureError(response.error)) return last;
      }
    }
    return last;
  };

  const randomToken = () => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return "pm_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  };

  window.PizzaMarOnline = function (db) {
    const getSettings = async () => {
      const response = await rpcVariants(db, RPC.settings, [{}, { p_id: 1 }]);
      if (!response.error) return { data: normalizeSettings(response.data), error: null };
      const fallback = await db.from("pm_web_settings")
        .select("accepting_orders,discount_percent,shipping_near,shipping_far")
        .eq("id", 1)
        .maybeSingle();
      if (!fallback.error && fallback.data) return { data: normalizeSettings(fallback.data), error: null };
      return { data: null, error: response.error || fallback.error };
    };

    const getCatalog = async () => {
      const response = await rpcVariants(db, RPC.catalog, [{}]);
      if (!response.error) return { data: normalizeCatalog(response.data), error: null };
      const fallback = await db.from("products")
        .select("id,name,price,category,active")
        .eq("active", true)
        .order("category")
        .order("name");
      if (!fallback.error) return { data: normalizeCatalog(fallback.data), error: null };
      return { data: [], error: null };
    };

    const getStorefront = async () => {
      const combined = await rpcVariants(db, RPC.storefront, [{}]);
      if (!combined.error) {
        const source = firstObject(combined.data) || {};
        const settings = normalizeSettings(source.settings || source);
        const catalog = normalizeCatalog(source.catalog || source.products || source.items || combined.data);
        return { data: { settings, catalog }, error: null };
      }
      const [settings, catalog] = await Promise.all([getSettings(), getCatalog()]);
      return {
        data: settings.data ? { settings: settings.data, catalog: catalog.data } : null,
        error: settings.error || null
      };
    };

    const createOrder = async (payload) => {
      const clientToken = payload.client_token || randomToken();
      const body = { ...payload, client_token: clientToken };
      const variants = [
        { p_customer_name: body.customer_name, p_payload: body },
        { p_payload: body },
        { p_order: body },
        { payload: body },
        { order: body },
        {
          p_customer_name: body.customer_name,
          p_phone: body.phone,
          p_address: body.address,
          p_cross_streets: body.cross_streets,
          p_neighborhood: body.neighborhood,
          p_fulfillment: body.fulfillment,
          p_payment_method: body.payment_method,
          p_items: body.items,
          p_client_token: body.client_token
        }
      ];
      const response = await rpcVariants(db, RPC.create, variants);
      if (!response.error) return { data: normalizeOrder(response.data), error: null };

      const fallbackRows = [
        {
          status: "pending", customer_name: body.customer_name, customer_phone: body.phone,
          address: body.address, cross_streets: body.cross_streets, neighborhood: body.neighborhood,
          fulfillment: body.fulfillment, payment_method: body.payment_method, items: body.items,
          subtotal: body.subtotal, discount: body.discount, shipping: body.shipping, total: body.total,
          public_token: body.client_token
        },
        {
          status: "pending", customer_name: body.customer_name, phone: body.phone,
          delivery_address: body.address, cross_streets: body.cross_streets, neighborhood: body.neighborhood,
          fulfillment_type: body.fulfillment, payment_method: body.payment_method, items: body.items,
          subtotal: body.subtotal, discount: body.discount, shipping_cost: body.shipping, total: body.total,
          client_token: body.client_token
        }
      ];
      for (const row of fallbackRows) {
        const insert = await db.from("pm_web_orders").insert(row).select("*").single();
        if (!insert.error) return { data: normalizeOrder(insert.data), error: null };
        if (!signatureError(insert.error)) return { data: null, error: insert.error };
      }
      return { data: null, error: response.error };
    };

    const getOrder = async (orderId, token) => {
      const variants = [
        { p_id: orderId, p_token: token },
        { p_order_id: orderId, p_public_token: token },
        { p_order_id: orderId, p_token: token },
        { p_id: orderId, p_token: token },
        { order_id: orderId, token }
      ];
      const response = await rpcVariants(db, RPC.publicOrder, variants);
      if (!response.error) return { data: normalizeOrder(response.data), error: null };
      return { data: null, error: response.error };
    };

    const listStaffOrders = async () => {
  const [active, history] = await Promise.all([
    db.rpc("pm_staff_orders", { p_history: false }),
    db.rpc("pm_staff_orders", { p_history: true })
  ]);

  const error = active.error || history.error;
  if (error) return { data: [], error };

  const rows = [
    ...rowsFrom(active.data),
    ...rowsFrom(history.data)
  ].map(normalizeOrder);

  const unique = new Map(rows.map(order => [order.id, order]));
  return { data: [...unique.values()], error: null };
};

    const listDrivers = async () => {
      const response = await db.rpc("pm_staff_delivery_drivers", {});
      return { data: response.error ? [] : rowsFrom(response.data), error: response.error };
    };
    const createDriver = async (name, token) => {
      return await db.rpc("pm_create_driver", { p_name: name.trim(), p_token: token });
    };
    const updateStatus = async (orderId, status, currentStatus, driverId = null) => {
      const canonical = value => ({ accepted: "preparing", picked_up: "on_the_way", in_transit: "on_the_way" })[value] || value;
      const next = canonical(status), expected = canonical(currentStatus);
      const reason = next === "rejected" ? "Rechazado desde la app interna" : "Actualizado desde la app interna";
      let response;
      if (next === "preparing" && expected === "pending") {
        response = await db.rpc("pm_accept_order", { p_id: orderId });
      } else if (next === "rejected" && expected === "pending") {
        response = await db.rpc("pm_reject_order", { p_id: orderId, p_reason: reason });
      } else if (next === "ready" && expected === "preparing") {
        response = await db.rpc("pm_ready_order", { p_id: orderId });
      } else if ((expected === "ready" && next === "on_the_way") || (expected === "on_the_way" && next === "delivered")) {
        if (next === "on_the_way" && !driverId) return { data: null, error: { message: "Seleccioná un repartidor activo antes de marcar retirado." } };
        response = await db.rpc("pm_transition", {
          p_id: orderId, p_expected: expected, p_next: next,
          p_reason: reason, p_actor: "staff", p_driver: next === "on_the_way" ? driverId : null
        });
      } else {
        return { data: null, error: { message: "El pedido cambió de estado. Actualizá la lista antes de continuar." } };
      }
      // No escritura directa: el servidor valida permisos, estados y registra el evento.
      if (response.error) return { data: null, error: response.error };
      const order = normalizeOrder(response.data);
      return order.id ? { data: order, error: null } : { data: null, error: { message: "No se recibió la confirmación. Actualizá la lista antes de reintentar." } };
    };

    return { getSettings, getCatalog, getStorefront, createOrder, getOrder, listStaffOrders, updateStatus, normalizeOrder, listDrivers, createDriver };
  };
})();

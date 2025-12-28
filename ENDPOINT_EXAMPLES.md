# API Endpoint Örnekleri

Aşağıda projedeki V1 endpointleri için kısa açıklama ve `curl` ile örnek istekler bulunmaktadır.

Base URL (local geliştirme): `http://localhost:3000`

---

**Health**: Basit sağlık kontrolü

- Açıklama: API'nin çalıştığını doğrular.
- Örnek:

```
curl -i "http://localhost:3000/v1/health"
```

---

**Search (Movie)**: Film arama (TMDB üzerinden)

- Yöntem: `GET`
- Path: `/v1/search`
- Query params: `query` (zorunlu), `language` (opsiyonel)
- Örnek:

```
curl -i "http://localhost:3000/v1/search?query=inception&language=en"
```

---

**Movie Lookup (by channel + title)**

- Yöntem: `GET`
- Path: `/v1/movie/lookup`
- Query params: `channelId` (zorunlu), `title` (zorunlu), `language` (opsiyonel)
- Örnek:

```
curl -i "http://localhost:3000/v1/movie/lookup?channelId=123&title=Inception%202010&language=en"
```

---

**Movie By ID**

- Yöntem: `GET`
- Path: `/v1/movie/{tmdbId}`
- Query params: `language` (opsiyonel)
- Örnek:

```
curl -i "http://localhost:3000/v1/movie/27205?language=en"
```

---

**Stream URL (signed proxy URL)**

- Yöntem: `GET`
- Path: `/v1/stream-url`
- Query params: `url` (zorunlu, yalnızca http kaynakları), `ttl` (opsiyonel, saniye)
- Not: Bu endpoint için `STREAM_SIGNING_SECRET` ve `STREAM_PROXY_BASE` env değişkenleri gereklidir.
- Örnek:

```
curl -i "http://localhost:3000/v1/stream-url?url=http://example.com/video.mp4&ttl=600"
```

---

**Series Search**

- Yöntem: `GET`
- Path: `/v1/series/search`
- Query params: `query` (zorunlu), `language` (opsiyonel), `top` (opsiyonel)
- Örnek:

```
curl -i "http://localhost:3000/v1/series/search?query=stranger%20things&language=en&top=3"
```

---

**Series By ID**

- Yöntem: `GET`
- Path: `/v1/series/{tmdbId}`
- Query params: `language` (opsiyonel)
- Örnek:

```
curl -i "http://localhost:3000/v1/series/66732?language=en"
```

---

**Series Season**

- Yöntem: `GET`
- Path: `/v1/series/{seriesId}/season/{seasonNumber}`
- Query params: `language` (opsiyonel)
- Örnek:

```
curl -i "http://localhost:3000/v1/series/66732/season/1?language=en"
```

---

**Series Episode**

- Yöntem: `GET`
- Path: `/v1/series/{seriesId}/season/{seasonNumber}/episode/{episodeNumber}`
- Query params: `language` (opsiyonel)
- Örnek:

```
curl -i "http://localhost:3000/v1/series/66732/season/1/episode/1?language=en"
```

---

**TMDB Proxy**

- Yöntem: `GET`
- Path: `/3/...` (TMDB API çağrılarını proxy'ler)
- Açıklama: `/3/movie/{id}` veya diğer TMDB yollarını aynen çağırabilirsiniz. `api_key` header yerine servis içindeki `TMDB_API_KEY` kullanılır.
- Örnek:

```
curl -i "http://localhost:3000/3/movie/27205?language=en"
```

---

**Redis CLI**

- Açıklama: Uygulamanın Redis'e yazdığı anahtarları hızlıca kontrol etmek için örnek `redis-cli` komutları. Docker Compose kullanıyorsanız aşağıdaki komutlar işinize yarar.
- Not: Büyük üretim veritabanlarında `KEYS` bloklayıcıdır; `--scan`/`SCAN` tercih edin.

Örnek komutlar:

```bash
# Ping
docker compose exec redis redis-cli PING

# Keys (küçük veri kümeleri için)
docker compose exec redis redis-cli KEYS "/movies/*"

# SCAN (büyük veritabanları için - güvenli)
docker compose exec redis redis-cli --scan --pattern "/movies/*"

# Bir anahtarın değeri
docker compose exec redis redis-cli GET "/movies/id/27205?lang=en"

# TTL kontrolü
docker compose exec redis redis-cli TTL "/movies/id/27205?lang=en"

# JSON okunurluğu (host'ta jq varsa)
docker compose exec redis redis-cli GET "/movies/id/27205?lang=en" | jq .
```

Alternatif - doğrudan `redis-cli` (host ortamı veya `REDIS_URL` ile):

```bash
redis-cli -u redis://127.0.0.1:6379 PING
redis-cli -u redis://127.0.0.1:6379 --scan --pattern "/series/*"
redis-cli -u redis://127.0.0.1:6379 GET "/series/id/66732?lang=en"
```

Notlar:

- Tüm GET endpointleri CORS yanıt başlıkları ile döner (kodu `index.js` içinde ayarlanmıştır).
- Local çalıştırma için `.env` içinde `TMDB_API_KEY`, gerekliyse `STREAM_SIGNING_SECRET` ve `STREAM_PROXY_BASE` ayarlayın.

İsterseniz ben bu dosyaya örnek başarılı JSON cevaplardan küçük örnekler de ekleyeyim — ister misiniz?

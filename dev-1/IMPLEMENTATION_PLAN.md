# AI Agent Competition Platform - Implementation Plan

## Scope (Phase 1 - MVP)

Based on our discussion:
- **Parameters**: JSON column + Pydantic validation
- **Currency**: Points only (no credits for now)
- **Connection**: REST API + polling (no WebSocket)

---

## Project Structure

```
agent-compete/
├── pyproject.toml
├── README.md
├── src/
│   └── agent_compete/
│       ├── __init__.py
│       ├── main.py              # FastAPI app
│       ├── config.py            # Settings
│       ├── db/
│       │   ├── __init__.py
│       │   ├── database.py      # Engine, session
│       │   ├── models.py        # SQLAlchemy models
│       │   └── migrations/      # Schema versioning
│       ├── modules/
│       │   ├── __init__.py
│       │   ├── agent/
│       │   │   ├── __init__.py
│       │   │   ├── router.py
│       │   │   ├── service.py
│       │   │   └── schema.py
│       │   ├── game/
│       │   │   ├── __init__.py
│       │   │   ├── router.py
│       │   │   ├── service.py
│       │   │   └── schema.py
│       │   ├── match/
│       │   │   ├── __init__.py
│       │   │   ├── router.py
│       │   │   ├── service.py
│       │   │   └── schema.py
│       │   └── points/
│       │       ├── __init__.py
│       │       ├── router.py
│       │       ├── service.py
│       │       └── schema.py
│       └── middleware/
│           ├── __init__.py
│           └── auth.py          # API Key validation
└── tests/
    ├── conftest.py
    ├── test_agent.py
    ├── test_game.py
    ├── test_match.py
    └── test_points.py
```

---

## Implementation Steps

### Step 1: Project Setup

**Tasks:**
- [ ] 1.1 Initialize project with `uv init agent-compete`
- [ ] 1.2 Add dependencies to `pyproject.toml`:
  ```toml
  dependencies = [
      "fastapi>=0.115.0",
      "uvicorn[standard]>=0.30.0",
      "sqlalchemy>=2.0.0",
      "pydantic>=2.0.0",
      "pydantic-settings>=2.0.0",
  ]

  [project.optional-dependencies]
  dev = [
      "pytest>=8.0.0",
      "pytest-asyncio>=0.23.0",
      "httpx>=0.27.0",
  ]
  ```
- [ ] 1.3 Create `src/agent_compete/config.py` with settings
- [ ] 1.4 Create basic `main.py` with health check endpoint

**Verify:** `uv run uvicorn agent_compete.main:app` starts successfully

---

### Step 2: Database Foundation

**Tasks:**
- [ ] 2.1 Create `db/database.py`:
  - SQLite engine with WAL mode
  - Session factory
  - `get_db` dependency
- [ ] 2.2 Create `db/models.py` with all tables:
  - `Agent`
  - `Game`
  - `Match`
  - `MatchParticipant`
  - `Action`
  - `PointTransaction`
- [ ] 2.3 Add `create_tables()` function for initial setup
- [ ] 2.4 Create seed data script for default games

**Verify:** Tables created in SQLite, can connect via DB browser

---

### Step 3: Agent Module

**Tasks:**
- [ ] 3.1 Create `agent/schema.py`:
  ```python
  class AgentCreate(BaseModel):
      name: str  # unique

  class AgentResponse(BaseModel):
      id: str
      name: str
      points_balance: int
      created_at: datetime

  class AgentWithKey(AgentResponse):
      api_key: str  # only returned on creation
  ```
- [ ] 3.2 Create `agent/service.py`:
  - `create_agent()` - generate ID, hash API key, add 100 bonus points
  - `get_agent_by_api_key()` - lookup by hashed key
  - `get_agent_by_id()`
  - `regenerate_api_key()`
- [ ] 3.3 Create `agent/router.py`:
  - `POST /agents` - register (no auth required)
  - `GET /agents/me` - get profile (auth required)
  - `POST /agents/me/regenerate-key` - new API key
- [ ] 3.4 Create `middleware/auth.py`:
  - Extract `X-API-Key` header
  - Validate and inject `current_agent` into request

**Verify:** Can register agent, receive API key, use key to access `/agents/me`

---

### Step 4: Game Module

**Tasks:**
- [ ] 4.1 Create `game/schema.py`:
  ```python
  class GameParameters(BaseModel):
      max_turns: int = 5
      turn_timeout_seconds: int = 60
      # extensible for different game types

  class GameResponse(BaseModel):
      id: str
      name: str
      category: str
      min_players: int
      max_players: int
      entry_fee: int
      winner_reward: int
      parameters: GameParameters
  ```
- [ ] 4.2 Create `game/service.py`:
  - `list_games()`
  - `get_game()`
- [ ] 4.3 Create `game/router.py`:
  - `GET /games` - list all games
  - `GET /games/{game_id}` - get game details
- [ ] 4.4 Add seed data: create "debate-v1" game

**Verify:** Can list games, view game details with parameters

---

### Step 5: Points Module

**Tasks:**
- [ ] 5.1 Create `points/schema.py`:
  ```python
  class BalanceResponse(BaseModel):
      points: int

  class TransactionResponse(BaseModel):
      id: str
      amount: int
      type: str  # registration|entry_fee|reward
      reference_id: str | None
      balance_after: int
      created_at: datetime
  ```
- [ ] 5.2 Create `points/service.py`:
  - `get_balance()`
  - `get_transactions()`
  - `deduct_points()` - with optimistic locking
  - `add_points()` - with optimistic locking
  - `record_transaction()` - audit trail
- [ ] 5.3 Create `points/router.py`:
  - `GET /points/balance`
  - `GET /points/transactions`

**Verify:** Balance shows 100 after registration, transactions recorded

---

### Step 6: Match Module - Core

**Tasks:**
- [ ] 6.1 Create `match/schema.py`:
  ```python
  class MatchCreate(BaseModel):
      game_id: str
      parameters: dict | None = None  # optional overrides

  class MatchResponse(BaseModel):
      id: str
      game_id: str
      status: str  # waiting|active|finished|cancelled
      parameters: dict
      current_phase: int
      current_turn: str | None
      players: list[str]
      created_at: datetime

  class MatchState(MatchResponse):
      state: dict  # game-specific state
      my_turn: bool

  class ActionSubmit(BaseModel):
      action_type: str
      payload: dict
  ```
- [ ] 6.2 Create `match/service.py`:
  - `create_match()` - create with default parameters
  - `list_matches()` - filter by status
  - `get_match()` - get match details
  - `get_match_state()` - include `my_turn` flag for polling
- [ ] 6.3 Create `match/router.py`:
  - `POST /matches` - create match
  - `GET /matches` - list matches
  - `GET /matches/{match_id}` - get match details
  - `GET /matches/{match_id}/state` - polling endpoint

**Verify:** Can create match, list matches, view match state

---

### Step 7: Match Module - Join & Actions

**Tasks:**
- [ ] 7.1 Add to `match/service.py`:
  - `join_match()`:
    - Check match status is "waiting"
    - Check not already joined
    - Check capacity
    - Deduct entry fee (with retry on conflict)
    - Add participant
    - If full → start match (status="active", set current_turn)
  - `submit_action()`:
    - Validate it's agent's turn
    - Validate phase
    - Record action
    - Advance turn/phase
    - Check win condition → finish match
  - `distribute_rewards()`:
    - Add points to winner
    - Record transaction
- [ ] 7.2 Add to `match/router.py`:
  - `POST /matches/{match_id}/join`
  - `POST /matches/{match_id}/action`
  - `GET /matches/{match_id}/result`

**Verify:** Full flow - create → join → actions → winner determined → rewards distributed

---

### Step 8: Concurrency & Error Handling

**Tasks:**
- [ ] 8.1 Implement retry decorator for optimistic lock conflicts
- [ ] 8.2 Add proper error responses:
  ```python
  class APIError(Exception):
      def __init__(self, code: str, message: str, status: int = 400):
          self.code = code
          self.message = message
          self.status = status

  # Error codes:
  # INSUFFICIENT_POINTS
  # MATCH_FULL
  # MATCH_NOT_WAITING
  # NOT_YOUR_TURN
  # INVALID_ACTION
  # CONCURRENCY_CONFLICT
  ```
- [ ] 8.3 Add exception handlers in `main.py`
- [ ] 8.4 Test concurrent join scenarios

**Verify:** Concurrent joins handled correctly, proper error messages returned

---

### Step 9: Testing

**Tasks:**
- [ ] 9.1 Setup `tests/conftest.py`:
  - Test database (in-memory SQLite)
  - Test client fixture
  - Agent factory fixture
- [ ] 9.2 `test_agent.py`:
  - Registration flow
  - Auth validation
  - Key regeneration
- [ ] 9.3 `test_game.py`:
  - List games
  - Get game details
- [ ] 9.4 `test_match.py`:
  - Create match
  - Join match (success + failures)
  - Submit actions
  - Win condition
- [ ] 9.5 `test_points.py`:
  - Balance tracking
  - Transaction history
  - Concurrent deductions

**Verify:** All tests pass with `uv run pytest`

---

### Step 10: Polish & Documentation

**Tasks:**
- [ ] 10.1 Add OpenAPI descriptions to all endpoints
- [ ] 10.2 Create `README.md` with:
  - Quick start guide
  - API overview
  - Example agent code
- [ ] 10.3 Add request validation error formatting
- [ ] 10.4 Add rate limiting (optional)

---

## Milestone Checklist

| Milestone | Steps | Deliverable |
|-----------|-------|-------------|
| **M1: Foundation** | 1-2 | Project runs, DB ready |
| **M2: Agent Auth** | 3 | Registration + API key auth works |
| **M3: Game Setup** | 4 | Games queryable |
| **M4: Points** | 5 | Balance + transactions work |
| **M5: Match Core** | 6 | Create + list matches |
| **M6: Full Flow** | 7 | Complete game loop works |
| **M7: Production Ready** | 8-10 | Error handling, tests, docs |

---

## Commands Reference

```bash
# Setup
uv init agent-compete
cd agent-compete
uv add fastapi uvicorn sqlalchemy pydantic pydantic-settings
uv add --dev pytest pytest-asyncio httpx

# Run
uv run uvicorn agent_compete.main:app --reload

# Test
uv run pytest -v

# Create tables (one-time)
uv run python -c "from agent_compete.db.database import create_tables; create_tables()"
```

---

## Ready to Start?

Begin with **Step 1: Project Setup**. Let me know when to proceed.

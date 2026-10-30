#
# Build
#
FROM golang:1.22 AS build

WORKDIR /go/src/catalogue

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 go build -o /catalogue .

#
# Run
#
FROM gcr.io/distroless/static-debian12

EXPOSE 8080

COPY --from=build /catalogue /catalogue

CMD ["/catalogue"]
